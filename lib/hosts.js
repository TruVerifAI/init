// Per-host installers. Each returns {installed: bool, notes: [..]} and NEVER
// throws — a failed host must not abort the others (mirror of the gates'
// fail-open posture, applied to setup).
//
// Two install shapes:
//  A. Marketplace hosts (claude, codex): the host's own CLI installs the
//     bundle; we run it when present, otherwise print the commands.
//  B. Config-file hosts (copilot, cursor CLI, gemini, vscode-user): WE write
//     the hook config, pointing at the gate code this package vendors into
//     ~/.truverifai/gates/current (absolute paths — no host-variable
//     assumptions like ${CODEX_PLUGIN_ROOT} needed).
//
// JSON config writes are MERGE-preserving: existing user hooks are kept; our
// entries are keyed/deduped by the marker in the command string.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const config = require("./config");
const { which } = require("./detect");

/** Run a host CLI command line (a FIXED literal string, never user input).
 *  execSync goes through the shell, which is REQUIRED on Windows: npm-installed
 *  CLIs like `claude` and `codex` are .cmd shims that CreateProcess cannot
 *  launch directly (the 0.19.0 `spawnSync claude ENOENT` bug, found in owner
 *  prod testing 2026-07-31). */
function runCLI(cmdline) {
  execSync(cmdline, { stdio: "pipe", timeout: 120000 });
}

const MARKER = "truverifai"; // dedup key inside command strings

function gatesPath(...parts) {
  return path.join(config.GATES_DIR, ...parts);
}

/** Copy the vendored gate bundle (shipped inside this npm package, generated
 *  from plugin-core at publish) to ~/.truverifai/gates/current. */
function installGateCode() {
  const src = path.join(__dirname, "..", "vendor", "gates");
  if (!fs.existsSync(src)) {
    return { installed: false, notes: ["vendor/gates missing from package — reinstall @truverifai/init"] };
  }
  fs.rmSync(config.GATES_DIR, { recursive: true, force: true });
  fs.cpSync(src, config.GATES_DIR, { recursive: true });
  // Version marker: gate_lib.plugin_version() probes <parent-of-gate-dir>/
  // plugin.json; without it every vendored-delivery deny stamps "vunknown"
  // (owner finding 2026-07-31, Codex G4). Written OUTSIDE the wiped dir.
  try {
    const version = require("../package.json").version;
    fs.writeFileSync(
      path.join(path.dirname(config.GATES_DIR), "plugin.json"),
      JSON.stringify({ name: "truverifai-vendored-gates", version: version }, null, 2) + "\n",
      "utf8"
    );
  } catch (e) {
    /* stamp-only; never block the install */
  }
  return { installed: true, notes: ["gate code -> " + config.GATES_DIR] };
}

/** OS-neutral hook command: node is guaranteed for npm-installed hosts and is
 *  the canonical hook-command form in Codex's docs. */
function nodeCmd(host, script) {
  const p = gatesPath("run_gate.js").split(path.sep).join("/");
  // FORWARD slashes + unquoted (two live rounds, 2026-07-31): Codex splits
  // hook commands with POSIX shlex_split (its own source), so backslashes
  // are ESCAPE chars (the path gets mangled, node exits 1 MODULE_NOT_FOUND)
  // and quote chars can land inside argv. A forward-slash whitespace-free
  // path survives shlex, cmd, and PowerShell alike; node accepts it on
  // Windows. Original note: Codex executes user-level hook
  // commands via naive arg-splitting (no shell), so quote characters become
  // part of the argv and node fails MODULE_NOT_FOUND with exit 1 (live
  // finding 2026-07-31). Quotes only when genuinely needed (spaces), where
  // shell-executing hosts still work.
  const quoted = /\s/.test(p) ? '"' + p + '"' : p;
  return "node " + quoted + " " + host + " " + script;
}

/** Codex: USER-level ~/.codex/hooks.json (2026-07-31 live findings). The
 *  plugin's bundled hooks.json is parsed at trust time but Codex never
 *  presents bundled hooks for TRUST, and untrusted hooks silently don't run —
 *  user/repo-level hooks DO get the trust prompt and were proven to fire.
 *  Claude-style nested shape (proven in a live session); node launcher
 *  commands (no bash dependency). Codex prompts "Hooks need review" on the
 *  next session — the user must pick Trust to arm them. */
function installCodexHooks() {
  const p = path.join(os.homedir(), ".codex", "hooks.json");
  const existing = readJson(p) || {};
  existing.hooks = existing.hooks || {};
  const groups = {
    PreToolUse: [
      {
        matcher: "Bash|PowerShell",
        hooks: [
          { type: "command", command: nodeCmd("codex", "audit_gate.py") },
          { type: "command", command: nodeCmd("codex", "stash_precommit_head.py") },
        ],
      },
      {
        // Not delivered by Codex today (PreToolUse fires for shell only,
        // upstream #16732/#18491) — registered forward-compatibly.
        matcher: "apply_patch|Edit|Write",
        hooks: [{ type: "command", command: nodeCmd("codex", "deliberate_gate.py") }],
      },
    ],
    PostToolUse: [
      {
        matcher: "Bash|PowerShell",
        hooks: [{ type: "command", command: nodeCmd("codex", "post_commit_backstop.py") }],
      },
    ],
  };
  for (const [ev, defs] of Object.entries(groups)) {
    const list = existing.hooks[ev] || [];
    const kept = list.filter((g) => !JSON.stringify(g || {}).includes(MARKER));
    existing.hooks[ev] = kept.concat(defs);
  }
  writeJson(p, existing);
  return {
    installed: true,
    notes: [
      "hook config -> " + p + " (user-level: the commit gate in every repo)",
      "Codex will ask 'Hooks need review' on your next session — choose Trust to arm the gates (untrusted hooks silently don't run)",
    ],
  };
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function gateCmd(host, script) {
  // OS-aware launcher command for a host's hook config (Q15 fix, 2026-07-29).
  // On Windows we must NOT emit `bash "C:\...run_gate.sh"`: on a machine whose
  // PATH `bash` is WSL (System32\bash.exe — the common case), WSL can't read a
  // C:\ path and the hook silently dies (a dead gate; on fail-closed Copilot
  // CLI, a denied edit). run_gate.cmd is the native cmd.exe launcher — it does
  // the same python probe, takes the same <host> <script> args, sets
  // TVAI_PLATFORM, and always exits 0. Hosts run "type":"command" hooks
  // through the OS shell (cmd.exe on Windows), so a bare quoted .cmd path
  // executes with no bash dependency at all.
  if (process.platform === "win32") {
    const p = gatesPath("run_gate.cmd");
    return '"' + p + '" ' + host + " " + script;
  }
  const p = gatesPath("run_gate.sh").replace(/\\/g, "/");
  return 'bash "' + p + '" ' + host + " " + script;
}

// Back-compat alias (some call sites still say bashCmd).
const bashCmd = gateCmd;

// ---------------------------------------------------------------------------
// A. Marketplace hosts
// ---------------------------------------------------------------------------

function installClaude() {
  const notes = [];
  if (which("claude")) {
    // Marketplace add is best-effort (a re-run may report it already exists);
    // the plugin install is what decides success.
    try {
      runCLI("claude plugin marketplace add https://github.com/TruVerifAI/claude-plugins.git");
    } catch (e) {
      notes.push("marketplace add skipped (" + String(e.message).slice(0, 120) + ")");
    }
    try {
      runCLI("claude plugin install panel-review@truverifai");
      notes.push("installed via claude CLI — run /reload-plugins in open sessions, then set your key: /plugin -> panel-review -> api_token (or rely on ~/.truverifai/config.json)");
      return { installed: true, notes };
    } catch (e) {
      notes.push("claude CLI present but install failed: " + String(e.message).slice(0, 300));
    }
  }
  notes.push("run inside Claude Code:");
  notes.push("  /plugin marketplace add https://github.com/TruVerifAI/claude-plugins.git");
  notes.push("  /plugin install panel-review@truverifai");
  notes.push("  /reload-plugins");
  return { installed: false, notes };
}

function installCodex() {
  const notes = [];
  if (which("codex")) {
    // Marketplace add is best-effort: a re-run on a machine that already has
    // the marketplace may error ("already exists") and must not block the
    // plugin add, which is what decides success.
    try {
      runCLI("codex plugin marketplace add TruVerifAI/codex-plugins");
    } catch (e) {
      notes.push("marketplace add skipped (" + String(e.message).slice(0, 120) + ")");
      // Already-added marketplaces are SNAPSHOTS: refresh so a republished
      // manifest (e.g. the 2026-07-31 schema fix) is picked up before the add.
      try {
        runCLI("codex plugin marketplace upgrade truverifai");
      } catch (e2) {
        try {
          runCLI("codex plugin marketplace upgrade");
        } catch (e3) {
          notes.push("marketplace refresh also failed — if the add below fails, run `codex plugin marketplace remove truverifai` then re-run");
        }
      }
    }
    try {
      runCLI("codex plugin add panel-review@truverifai");
      notes.push("installed via codex CLI");
      return { installed: true, notes };
    } catch (e) {
      notes.push("codex CLI present but install failed: " + String(e.message).slice(0, 300));
    }
  }
  notes.push("run: codex plugin marketplace add TruVerifAI/codex-plugins");
  notes.push("then: codex plugin add panel-review@truverifai");
  return { installed: false, notes };
}

// ---------------------------------------------------------------------------
// B. Config-file hosts
// ---------------------------------------------------------------------------

/** Copilot CLI + VS Code + Cloud Agent all read .github/hooks/*.json in the
 *  repo; user-level is ~/.copilot/hooks/. We write BOTH camelCase (CLI) —
 *  VS Code converts CLI configs itself. */
function installCopilot(cwd, scope) {
  // Docs sweep 2026-08-02 (docs.github.com hooks-reference + use-hooks): the
  // file needs a {version, hooks} WRAPPER and each event holds FLAT entries
  // ({type, command, ...} — the cross-platform `command` field; NOT
  // claude-style nested {hooks:[...]} groups, which don't parse). Multiple
  // entries per event run sequentially, any deny wins (documented). No
  // matchers: Copilot's tool names aren't exhaustively documented, so both
  // gates fire on every tool and exit fast on non-matching input.
  const entry = (script) => ({
    type: "command",
    command: nodeCmd("copilot_cli", script),
  });
  const hook = {
    version: 1,
    hooks: {
      preToolUse: [entry("deliberate_gate.py"), entry("audit_gate.py")],
      // Post-commit backstop (fused create && git commit): postToolUse
      // documents a TOP-LEVEL additionalContext appended to model context;
      // postToolUseFailure covers `commit && push` where the push fails.
      // Non-preToolUse events fail OPEN on non-zero exit (reference §5).
      postToolUse: [entry("post_commit_backstop.py")],
      postToolUseFailure: [entry("post_commit_backstop.py")],
    },
  };
  // VS Code companion file (docs sweep 2026-08-02, code.visualstudio.com
  // agent-customization/hooks): VS Code auto-loads the SAME directories but
  // wants PascalCase events, FLAT entries, no version wrapper, and the
  // vscode host adapter (claude-shaped hookSpecificOutput deny — the CLI's
  // top-level permissionDecision wire would not parse there). The CLI
  // ignores this file's unknown PascalCase event names, so no double-gating.
  const ventry = (script) => ({
    type: "command",
    command: nodeCmd("vscode", script),
  });
  const vshook = {
    hooks: {
      PreToolUse: [ventry("deliberate_gate.py"), ventry("audit_gate.py")],
      PostToolUse: [ventry("post_commit_backstop.py")],
    },
  };
  const dir =
    scope === "user"
      ? path.join(os.homedir(), ".copilot", "hooks")
      : path.join(cwd, ".github", "hooks");
  const target = path.join(dir, "truverifai-gate.json");
  const vstarget = path.join(dir, "truverifai-vscode.json");
  writeJson(target, hook);
  writeJson(vstarget, vshook);
  return {
    installed: true,
    notes: [
      "hook config -> " + target + " (Copilot CLI) + " + vstarget + " (VS Code agent)",
      scope === "user"
        ? "applies to Copilot CLI + VS Code for this user"
        : "applies to Copilot CLI + VS Code agent for THIS repo. NOT the Cloud Agent: its sandbox honors only `bash` field hooks and has no vendored gates.",
    ],
  };
}

/** Cursor: USER-level ~/.cursor/hooks.json (init v2, deliberation mcp_8bb74aec).
 *  Cursor reads user-level hooks in BOTH the IDE agent (since 1.7) and the CLI,
 *  in every repo — so one write covers everything and nothing gate-shaped lands
 *  in the repo to be accidentally committed. Repo-level .cursor/hooks.json
 *  remains a documented team option; if one exists we warn and leave it.
 *  Only shell events are delivered as of 2026-07 (commit gate); the write hook
 *  is still REGISTERED, forward-compatibly, per plan §2.5. */
function installCursor(cwd) {
  const p = path.join(os.homedir(), ".cursor", "hooks.json");
  const existing = readJson(p) || { version: 1, hooks: {} };
  existing.version = existing.version || 1;
  existing.hooks = existing.hooks || {};
  const ours = {
    // "type" is part of Cursor's documented entry schema; typeless entries
    // are the prime suspect for the silent no-fire in the C3 test
    // (2026-07-31). "command" is the only engine we use.
    beforeShellExecution: { type: "command", command: nodeCmd("cursor_cli", "audit_gate.py") },
    // preToolUse: write gate — CONFIRMED LIVE on both surfaces (C3+C4 certs
    // 2026-08-01; the CLI delivers Write events now).
    preToolUse: { type: "command", command: nodeCmd("cursor_cli", "deliberate_gate.py") },
    // Post-commit backstop: catches the fused `create && git commit` that the
    // pre-exec commit gate can't see (empty staged set at hook time). Cursor's
    // postToolUse/postToolUseFailure support additional_context (docs verified
    // 2026-08-01); afterShellExecution is observational-only, so not used.
    // v1 ships WITHOUT the pre-side HEAD stash (multi-entry event arrays are
    // untested on Cursor) — the backstop degrades to tip-commit-only, which
    // covers the fused single-commit case.
    postToolUse: { type: "command", command: nodeCmd("cursor_cli", "post_commit_backstop.py") },
    postToolUseFailure: { type: "command", command: nodeCmd("cursor_cli", "post_commit_backstop.py") },
  };
  for (const [event, def] of Object.entries(ours)) {
    const list = existing.hooks[event] || [];
    const kept = list.filter(
      (h) => !(h && typeof h.command === "string" && h.command.includes(MARKER))
    );
    kept.push(def);
    existing.hooks[event] = kept;
  }
  writeJson(p, existing);
  const notes = [
    "hook config -> " + p + " (user-level: covers the Cursor IDE agent AND the CLI, in every repo; commit gate today — the write hook is registered for when Cursor delivers edit events)",
  ];
  const repoLevel = path.join(cwd, ".cursor", "hooks.json");
  if (fs.existsSync(repoLevel)) {
    notes.push("note: repo-level .cursor/hooks.json also exists — leaving it (both run; remove one to avoid double gating)");
  }
  return { installed: true, notes };
}

/** Gemini CLI: project-level .gemini/settings.json hooks (merged by Gemini
 *  with user settings). Extension install is the richer path; this covers
 *  gate hooks without waiting for extension approval. */
function installGemini(cwd) {
  const p = path.join(cwd, ".gemini", "settings.json");
  const existing = readJson(p) || {};
  existing.hooks = existing.hooks || {};
  // Node launcher commands (codex lessons applied broadly: forward-slash,
  // unquoted, shell-agnostic) and REAL matchers per docs (gemini matchers are
  // regex on tool names) instead of ".*" firing both gates on every tool.
  const mk = (matcher, script, name) => ({
    matcher: matcher,
    hooks: [{ type: "command", name: name, command: nodeCmd("gemini", script) }],
  });
  const groups = [
    mk("write_file|replace|edit_file", "deliberate_gate.py", "truverifai-write-gate"),
    mk("run_shell_command", "audit_gate.py", "truverifai-commit-gate"),
  ];
  const list = (existing.hooks.BeforeTool || []).filter(
    (grp) => !JSON.stringify(grp || {}).includes(MARKER)
  );
  existing.hooks.BeforeTool = list.concat(groups);
  // Post-commit backstop (docs verified 2026-08-01: AfterTool fires after the
  // tool — including on errors, tool_response.error — with real cwd, and
  // hookSpecificOutput.additionalContext is documented as appended to the
  // tool result the model sees). Catches the fused `create && git commit`
  // the pre-exec commit gate can't see. Single-hook group, same v1 posture
  // as Cursor: no pre-side HEAD stash — tip-only degradation, whose KNOWN
  // v1 boundary is that a multi-commit chain in ONE invocation classifies
  // only the tip commit (earlier commits in the chain go un-flagged).
  const after = (existing.hooks.AfterTool || []).filter(
    (grp) => !JSON.stringify(grp || {}).includes(MARKER)
  );
  existing.hooks.AfterTool = after.concat([
    mk("run_shell_command", "post_commit_backstop.py", "truverifai-post-backstop"),
  ]);
  writeJson(p, existing);
  return {
    installed: true,
    notes: [
      "hook config -> " + p + " (project-level; commit to cover your team)",
      "richer install: gemini extensions install https://github.com/TruVerifAI/gemini-extension",
    ],
  };
}

/** Phase 3 — the universal fallback: a git pre-commit hook running the commit
 *  gate against the staged diff. Covers hosts with NO hook API (Zed, Aider,
 *  JetBrains, web IDEs) and commits made outside any agent.
 *
 *  Deny protocol: the gate exits 21 on a deliberate deny; the wrapper maps
 *  21 -> exit 1 (git aborts) and EVERYTHING else -> 0, so a crash/traceback
 *  can never block a commit (fail open). Bypass: git commit --no-verify. */
/** Antigravity: workspace-level .agents/hooks.json (docs sweep 2026-08-02:
 *  hooks load ONLY from .agents/hooks.json or ~/.gemini/config/hooks.json —
 *  plugin-contributed hooks are UNDOCUMENTED, so the drop-in bundle channel
 *  was stripped). Top-level keys are hook-NAMES: we own exactly the
 *  "truverifai-gates" key and preserve every other key verbatim. */
function installAntigravity(cwd) {
  const p = path.join(cwd, ".agents", "hooks.json");
  const existing = readJson(p) || {};
  const grp = (matcher, script) => ({
    matcher: matcher,
    hooks: [{ type: "command", command: nodeCmd("antigravity", script) }],
  });
  existing["truverifai-gates"] = {
    enabled: true,
    PreToolUse: [
      // The docs' shell example is run_command; the gemini lineage uses
      // run_shell_command — cover both.
      grp("run_shell_command|run_command", "audit_gate.py"),
      grp("write_file|replace|edit_file", "deliberate_gate.py"),
    ],
    // Post-commit backstop: PostToolUse output cannot inject model context
    // on this host ({} only) — the backstop still posts its dashboard row.
    PostToolUse: [grp("run_shell_command|run_command", "post_commit_backstop.py")],
  };
  writeJson(p, existing);
  return {
    installed: true,
    notes: [
      "hook config -> " + p + " (workspace-level; commit to cover your team)",
      "note: backstop advisories are dashboard-only on Antigravity (PostToolUse hooks cannot inject model context)",
    ],
  };
}

function installGitPrecommit(cwd) {
  const hookDir = path.join(cwd, ".git", "hooks");
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    return { installed: false, notes: ["not a git repo — skipped pre-commit hook"] };
  }
  const target = path.join(hookDir, "pre-commit");
  const gate = gatesPath("audit_gate.py").replace(/\\/g, "/");
  const script =
    "#!/bin/sh\n" +
    "# truverifai pre-commit commit gate (installed by tvai; edit source, not this)\n" +
    "# Deny = gate exit 21 -> block; ANY other exit (incl. crashes) fails OPEN.\n" +
    'TVAI_PLATFORM=git_precommit\n' +
    "export TVAI_PLATFORM\n" +
    "for c in python3 python py; do\n" +
    '  if command -v "$c" >/dev/null 2>&1 && "$c" -c "" >/dev/null 2>&1; then\n' +
    '    "$c" "' + gate + '" < /dev/null\n' +
    "    if [ $? -eq 21 ]; then exit 1; fi\n" +
    "    exit 0\n" +
    "  fi\n" +
    "done\n" +
    "exit 0\n";
  let existing = "";
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch (e) {
    /* none */
  }
  if (existing && !existing.includes(MARKER)) {
    return {
      installed: false,
      notes: [
        "a pre-commit hook already exists at " + target + " — not overwriting.",
        "add manually:  TVAI_PLATFORM=git_precommit python \"" + gate + "\" </dev/null; [ $? -eq 21 ] && exit 1 || true",
      ],
    };
  }
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(target, script, { encoding: "utf8", mode: 0o755 });
  try {
    fs.chmodSync(target, 0o755);
  } catch (e) {
    /* windows */
  }
  const notes = ["git pre-commit commit gate -> " + target +
                 " (covers ANY agent + manual commits; bypass: git commit --no-verify)"];
  // Audit mcp_fdb3802f F-002: an installed hook with NO key configured gives
  // silent zero protection (every run fails open). Say so AT INSTALL TIME.
  if (!config.apiKey()) {
    notes.push("⚠ NO API KEY CONFIGURED — the gate will FAIL OPEN on every " +
               "commit (zero protection) until you run `tvai login` or set " +
               "TVAI_API_KEY.");
  }
  return { installed: true, notes };
}

/** Remove every hook config `init` wrote (X9b). The mirror of the installers
 *  above, and the piece `logout` never had: logout clears the key and the MCP
 *  entries, so the gates fail open for want of a token — it LOOKS uninstalled
 *  while every hook is still wired in and one `tvai login` re-arms all of it.
 *
 *  Two removal shapes, matching how each file was written:
 *   - files that are entirely OURS (truverifai-gate.json, truverifai-vscode.json,
 *     the pre-commit wrapper) are deleted outright, but only after confirming
 *     our MARKER is in them — never delete a file we did not write.
 *   - files we MERGED into (codex/cursor/gemini hooks, .agents/hooks.json) have
 *     only our own entries filtered out, by the same MARKER the installers key
 *     on, so a user's own hooks survive untouched.
 *
 *  Never throws; returns human-readable notes. */
function removeHooks(cwd) {
  const notes = [];
  // Sandbox-aware home (audit mcp_e78430be F-003). This is the one DESTRUCTIVE
  // command in the CLI, so it must honor TVAI_HOME_OVERRIDE — a test or harness
  // that overrides it must not be able to reach real user files. Proven
  // necessary while building this: a run with only HOME/USERPROFILE overridden
  // still reached the real VS Code profile through %APPDATA%.
  const home = require("./mcpconf").homeDir();
  const gatesDir = home === os.homedir()
    ? config.GATES_DIR
    : path.join(home, ".truverifai", "gates", "current");

  /** Delete a file that is entirely ours.
   *
   *  Ownership needs a STRONG signature, not a substring (audit mcp_d79462de
   *  F-005). A bare `text.includes("truverifai")` would delete a user's
   *  hand-written pre-commit hook that merely MENTIONS us — "# make sure
   *  truverifai doesn't block the release script" is enough to match, and
   *  deleting someone's own git hook is unrecoverable. Each signature below is
   *  a line the corresponding installer writes verbatim, so it identifies a
   *  file we generated rather than one that talks about us. */
  const dropOurFile = (p, label, signature) => {
    try {
      if (!fs.existsSync(p)) return;
      const text = fs.readFileSync(p, "utf8");
      if (!text.includes(signature)) {
        notes.push("left alone (not a file we generated): " + p);
        return;
      }
      fs.rmSync(p);
      notes.push("removed " + label + ": " + p);
    } catch (e) {
      notes.push(p + ": " + String(e.message).slice(0, 80));
    }
  };

  /** Filter our entries out of a merged JSON hooks file, preserving the rest. */
  const filterMerged = (p, label, mutate) => {
    try {
      if (!fs.existsSync(p)) return;
      const before = fs.readFileSync(p, "utf8");
      if (!before.includes(MARKER)) return;
      const o = JSON.parse(before);
      mutate(o);
      fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n", { encoding: "utf8" });
      notes.push("removed our entries from " + label + ": " + p);
    } catch (e) {
      notes.push(p + ": " + String(e.message).slice(0, 80));
    }
  };

  const mine = (v) => JSON.stringify(v || {}).includes(MARKER);

  // Codex + Cursor: claude-shaped/flat event maps we merged into.
  for (const [p, label] of [
    [path.join(home, ".codex", "hooks.json"), "Codex hooks"],
    [path.join(home, ".cursor", "hooks.json"), "Cursor hooks"],
  ]) {
    filterMerged(p, label, (o) => {
      for (const ev of Object.keys(o.hooks || {})) {
        const list = o.hooks[ev];
        if (Array.isArray(list)) o.hooks[ev] = list.filter((g) => !mine(g));
      }
    });
  }

  // Gemini: BeforeTool / AfterTool groups in the repo's .gemini/settings.json.
  filterMerged(path.join(cwd, ".gemini", "settings.json"), "Gemini hooks", (o) => {
    for (const ev of ["BeforeTool", "AfterTool"]) {
      const list = (o.hooks || {})[ev];
      if (Array.isArray(list)) o.hooks[ev] = list.filter((g) => !mine(g));
    }
  });

  // Antigravity: we own exactly the one top-level key.
  filterMerged(path.join(cwd, ".agents", "hooks.json"), "Antigravity hooks", (o) => {
    delete o["truverifai-gates"];
  });

  // Copilot / VS Code: whole files, ours, at user AND repo scope.
  // Signatures = a substring each installer writes VERBATIM, so we only ever
  // delete a file we generated. nodeCmd() emits `run_gate.js <host> <script>`.
  for (const dir of [path.join(home, ".copilot", "hooks"),
                     path.join(cwd, ".github", "hooks")]) {
    dropOurFile(path.join(dir, "truverifai-gate.json"), "Copilot CLI hooks",
                "run_gate.js copilot_cli");
    dropOurFile(path.join(dir, "truverifai-vscode.json"), "VS Code agent hooks",
                "run_gate.js vscode");
  }

  // The universal git fallback. Signature = the header comment
  // installGitPrecommit() writes as line 2 of the wrapper.
  dropOurFile(path.join(cwd, ".git", "hooks", "pre-commit"), "git pre-commit gate",
              "truverifai pre-commit commit gate (installed by tvai");

  // The vendored gate code itself.
  try {
    if (fs.existsSync(gatesDir)) {
      fs.rmSync(gatesDir, { recursive: true, force: true });
      notes.push("removed gate code: " + gatesDir);
    }
  } catch (e) {
    notes.push(gatesDir + ": " + String(e.message).slice(0, 80));
  }

  if (!notes.length) notes.push("no TruVerifAI hook configs found — nothing to remove");
  return notes;
}

module.exports = {
  MARKER,
  removeHooks,
  installGateCode,
  installClaude,
  installCodex,
  installCodexHooks,
  installAntigravity,
  installCopilot,
  installCursor,
  installGemini,
  installGitPrecommit,
  gatesPath,
  gateCmd,
  bashCmd,
};
