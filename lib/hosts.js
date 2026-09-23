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
const { execSync, spawnSync } = require("child_process");

const config = require("./config");
const { which, gitRepoRoot } = require("./detect");

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

// --- Gate-code install: stage -> verify -> swap (roadmap 4.4) ----------------
//
// The old implementation was `rmSync(current)` then `cpSync(src, current)`.
// If anything interrupted the copy — Ctrl-C, disk full, a crash — the live
// directory was left EMPTY: every hook on the machine pointed at a missing
// run_gate.js, every gate silently failed open, and nothing said so. That is
// the Problem-1 disaster, self-inflicted by our own installer, and it was
// reachable on every single `npx @truverifai/init` run.
//
// Now the dangerous window is two adjacent directory-entry renames instead of
// the whole length of a recursive copy:
//
//   1. STAGE   copy into gates/.staging-<pid> — `current` untouched, working
//   2. VERIFY  the staged tree matches the source, file for file — a partial
//              or corrupted copy fails HERE, while it is still a temp folder
//              nobody uses
//   3. SWAP    rename current -> .trash-<pid>   (old version intact, aside)
//              rename .staging  -> current       (new version live)
//              delete .trash                     (just litter now — LAST,
//              because deleting does real work file-by-file and is where
//              antivirus/locks/Ctrl-C land you; a failure here is ignorable)
//
// Staging lives INSIDE ~/.truverifai/gates — the same volume as `current`, on
// purpose: across volumes a "rename" silently becomes a copy and the whole
// window-shrinking argument collapses (which is why the OS temp dir, the
// obvious place for a temp folder, is exactly wrong here).
//
// The one unrecoverable-in-process window — dying BETWEEN the two renames —
// is closed by recoverGateDirs(), which runs before anything else: if
// `current` is missing and a .trash-* exists, it renames it back. ONE version
// on disk, ever (owner decision, 2026-08-17: versioned-dirs-with-a-pointer
// was rejected — Claude Code's own plugin cache demonstrates how that design
// accumulates orphans nobody can reason about). Rollback is
// `npx @truverifai/init@<version>`, since npm keeps every published version.

const crypto = require("crypto");

function gatesParent() {
  return path.dirname(config.GATES_DIR);
}

/** rmSync that keeps this module's never-throws promise (review finding G):
 *  `force:true` suppresses ENOENT but NOT a Windows EBUSY/EPERM on a locked
 *  file — and several cleanup calls here run inside catch blocks, where a
 *  second throw would escape installGateCode and crash `init` instead of
 *  letting it report. Cleanup is best-effort by definition; the sweeps pick up
 *  anything a lock protected. */
function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    /* locked/busy — the next run's sweep gets it */
  }
}

/** Heal leftovers from an interrupted install. Runs BEFORE any install step,
 *  so a machine that died mid-swap self-repairs on the next init instead of
 *  needing the user to understand what happened. Returns notes (may be []). */
function recoverGateDirs() {
  const notes = [];
  const parent = gatesParent();
  let entries = [];
  try {
    entries = fs.readdirSync(parent);
  } catch (e) {
    return notes; // no gates dir yet — nothing to heal
  }
  const trash = entries.filter((n) => n.startsWith(".trash-"));
  const staging = entries.filter((n) => n.startsWith(".staging-"));
  // Died between the two renames: `current` is gone but the old version is
  // sitting intact in .trash-*. Put it back — a working old install beats an
  // empty directory every time.
  if (!fs.existsSync(config.GATES_DIR) && trash.length) {
    try {
      fs.renameSync(path.join(parent, trash[0]), config.GATES_DIR);
      notes.push("recovered the previous gate install from an interrupted update (" + trash[0] + ")");
      trash.shift();
    } catch (e) {
      notes.push("found an interrupted update (" + trash[0] + ") but could not restore it: " + String(e.message).slice(0, 80));
    }
  }
  // Everything else with our prefixes is litter from a dead process —
  // PROBABLY. A second `init` can be running RIGHT NOW, and its live
  // .staging-<pid> looks identical to a dead one; sweeping it mid-copy makes
  // that init's verify fail for no user-visible reason (review finding H). So
  // the sweep is AGE-GATED, like resolve_python's temp-file sweep: anything
  // our prefixes own that hasn't been touched in 10 minutes is dead — no real
  // stage-verify-swap lives that long.
  for (const n of trash.concat(staging)) {
    const p = path.join(parent, n);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 10 * 60 * 1000) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch (e) {
      /* locked or raced — the next init sweeps it */
    }
  }
  return notes;
}

/** Compare the staged tree against the source, file for file, by content hash.
 *  This is what turns "the copy was interrupted / the disk lied" from a dead
 *  machine into a no-op: a bad stage never reaches the swap. Returns null on
 *  match, or a human-readable reason. */
function verifyStaged(src, staged) {
  const listFiles = (root) => {
    const out = [];
    const walk = (d, rel) => {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        const r = rel ? rel + "/" + n : n;
        if (fs.statSync(p).isDirectory()) walk(p, r);
        else out.push(r);
      }
    };
    walk(root, "");
    return out.sort();
  };
  const hash = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  try {
    const want = listFiles(src);
    const got = listFiles(staged);
    if (want.length !== got.length || want.some((f, i) => f !== got[i])) {
      return "file list differs (" + want.length + " expected, " + got.length + " staged)";
    }
    for (const f of want) {
      if (hash(path.join(src, f)) !== hash(path.join(staged, f))) {
        return "content mismatch: " + f;
      }
    }
    return null;
  } catch (e) {
    return "verification failed: " + String(e.message).slice(0, 80);
  }
}

/** Copy the vendored gate bundle (shipped inside this npm package, generated
 *  from plugin-core at publish) to ~/.truverifai/gates/current — staged,
 *  verified, then swapped in two renames. */
function installGateCode() {
  const src = path.join(__dirname, "..", "vendor", "gates");
  if (!fs.existsSync(src)) {
    return { installed: false, notes: ["vendor/gates missing from package — reinstall @truverifai/init"] };
  }
  const notes = recoverGateDirs();
  const parent = gatesParent();
  // ORDER IS LOAD-BEARING: recoverGateDirs() swept stale .staging-*/.trash-*
  // BEFORE these names are minted, so a reused PID can never collide with a
  // dead run's leftovers. Creating before sweeping would break that.
  const staging = path.join(parent, ".staging-" + process.pid);
  const trash = path.join(parent, ".trash-" + process.pid);

  // 1. STAGE — the live install keeps working throughout.
  try {
    safeRm(staging);
    fs.mkdirSync(parent, { recursive: true });
    fs.cpSync(src, staging, { recursive: true });
  } catch (e) {
    safeRm(staging);
    return { installed: false, notes: notes.concat(["staging the new gate code failed (" + String(e.message).slice(0, 80) + ") — the existing install is untouched"]) };
  }

  // 2. VERIFY — while it is still a temp folder nobody uses.
  const bad = verifyStaged(src, staging);
  if (bad) {
    safeRm(staging);
    return { installed: false, notes: notes.concat(["staged gate code failed verification (" + bad + ") — the existing install is untouched; re-run npx @truverifai/init@latest"]) };
  }

  // 3. SWAP — rename, rename, delete. NEVER delete-first: that is the order
  // whose failure mode is an empty live directory.
  try {
    if (fs.existsSync(config.GATES_DIR)) fs.renameSync(config.GATES_DIR, trash);
  } catch (e) {
    // Windows refuses the rename while a gate is mid-execution with a file
    // open. Nothing has changed; the old install is still live. Retry later.
    safeRm(staging);
    return { installed: false, notes: notes.concat(["could not replace the running gate code (a gate may be executing right now) — nothing was changed; re-run in a moment"]) };
  }
  try {
    fs.renameSync(staging, config.GATES_DIR);
  } catch (e) {
    // The one bad spot. Put the old version straight back.
    try {
      fs.renameSync(trash, config.GATES_DIR);
      safeRm(staging);
      return { installed: false, notes: notes.concat(["swap failed (" + String(e.message).slice(0, 80) + ") — the previous install was RESTORED and is live"]) };
    } catch (e2) {
      return { installed: false, notes: notes.concat(["SWAP FAILED AND RESTORE FAILED — the gates are NOT installed. Re-run npx @truverifai/init@latest (the previous version is preserved at " + trash + ")"]) };
    }
  }
  safeRm(trash); // ~1MB of litter if locked; recoverGateDirs sweeps it next run

  // Version marker: gate_lib.plugin_version() probes <parent-of-gate-dir>/
  // plugin.json; without it every vendored-delivery deny stamps "vunknown"
  // (owner finding 2026-07-31, Codex G4). Written OUTSIDE the swapped dir.
  try {
    const version = require("../package.json").version;
    fs.writeFileSync(
      path.join(parent, "plugin.json"),
      JSON.stringify({ name: "truverifai-vendored-gates", version: version }, null, 2) + "\n",
      "utf8"
    );
  } catch (e) {
    /* stamp-only; never block the install */
  }
  return { installed: true, notes: notes.concat(["gate code -> " + config.GATES_DIR + " (staged, verified, swapped)"]) };
}

/** Resolve the Python interpreter ONCE and record it (roadmap 1.1 / 1.4).
 *
 *  This is the whole point of the interpreter work: a hook must never search in
 *  its own process, because on Windows searching can kill it outright and the
 *  crash is below JavaScript, uncatchable. Searching happens HERE — at install
 *  time, where a failure is visible to a human — and the answer is written to
 *  ~/.truverifai/python-path.json for every hook to read.
 *
 *  Delegated to the INSTALLED resolver rather than reimplemented, so install
 *  time and the hook's own repair path can never disagree about what a usable
 *  interpreter is (one implementation, one entry point). It is invoked as a
 *  child process for the same reason the hook does: if the search is killed,
 *  the installer survives and reports it.
 *
 *  Passing GATES_DIR means the chosen interpreter is verified against the gate
 *  code that will ACTUALLY run, not against a copy somewhere else. */
function recordInterpreter() {
  const resolver = gatesPath("resolve_python.js");
  if (!fs.existsSync(resolver)) {
    return { installed: false, notes: ["resolve_python.js missing from the installed gate code — reinstall @truverifai/init"] };
  }
  const r = spawnSync(process.execPath, [resolver, "--record", config.GATES_DIR], {
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = {};
  try {
    out = JSON.parse(String(r.stdout || "").trim() || "{}");
  } catch (e) {
    /* fall through to the generic failure below */
  }
  if (r.status === 0 && out.python) {
    return { installed: true, python: out.python, notes: ["python resolved: " + out.python] };
  }
  // Loud, and specific about WHY (1.4). "Could not find Python" with no detail
  // is what made the last three of these cost hours; the resolver reports each
  // candidate it tried and what happened.
  const tried = Array.isArray(out.tried) && out.tried.length
    ? out.tried.map((t) => t.cmd + ": " + t.outcome).join("; ")
    : "no candidates reported";
  return {
    installed: false,
    notes: [
      "NO USABLE PYTHON FOUND — the gates cannot run on this machine.",
      "tried: " + tried,
      "Install Python 3 (python.org, or `brew install python` on macOS), then re-run: npx @truverifai/init@latest",
    ],
  };
}

/** Run the gate-endpoint self-check during install (roadmap 1b.3).
 *
 *  `gate_selfcheck.py` already existed, is free, and is one round trip. It
 *  proves the half of the product that the MCP tools do NOT cover: the gates
 *  talk to a different endpoint, and a failure there is fail-open BY DESIGN, so
 *  it is invisible until a gate silently lets something through.
 *
 *  On the 2026-08-17 macOS round that invisibility cost hours — the gates were
 *  allowing everything because that machine's Python could not verify any TLS
 *  certificate, and nothing said so until six test rows had failed. This check
 *  would have caught it in the first five seconds of the install, before a
 *  single row ran. It only ever had to be CALLED.
 *
 *  Reports, never throws: a failure here must not abort the rest of the install
 *  (the same fail-open posture the gates themselves have, applied to setup). */
function runSelfCheck(python, apiKey) {
  const script = gatesPath("gate_selfcheck.py");
  if (!python) {
    return { installed: false, notes: ["gate-endpoint self-check SKIPPED — no interpreter"] };
  }
  if (!fs.existsSync(script)) {
    return { installed: false, notes: ["gate_selfcheck.py missing from the installed gate code"] };
  }
  const r = spawnSync(python, [script], {
    encoding: "utf8",
    // The self-check's own HTTP call is bounded (urlopen timeout=5), but DNS
    // resolution is NOT covered by that timeout on any platform. This is the
    // outer bound that keeps `init` from sitting on a black-holed resolver in
    // an air-gapped or firewalled environment.
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, { TVAI_TOKEN: apiKey || "" }),
  });
  const out = String(r.stdout || "").trim();
  if (r.status === 0) {
    return { installed: true, notes: ["gate endpoint reachable and authorized"] };
  }
  // Surface the script's OWN lines: it now names the real reason (a TLS trust
  // failure, a rejected key) instead of listing four possible causes.
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("FAIL") || l.startsWith("The gates"));
  return {
    installed: false,
    notes: [
      "THE GATES CANNOT REACH OUR SERVER — they will let everything through.",
    ].concat(lines.length ? lines : ["gate_selfcheck.py exited " + r.status]),
  };
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
  // Sandbox-aware home (adversarial review 2026-09-17 finding 5): every
  // WRITER must resolve home through the shared override-aware helper, or a
  // sandboxed test/run rewrites real user hook files.
  const p = path.join(require("./mcpconf").homeDir(), ".codex", "hooks.json");
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

// gateCmd/bashCmd (the run_gate.sh/.cmd command builders) were deleted with
// run_gate.sh itself (Mac report A13): every live hook command goes through
// nodeCmd since the launcher moved to Node, and dead code that builds a
// command for a dead file is how the file looked load-bearing for a round.

// ---------------------------------------------------------------------------
// A. Marketplace hosts
// ---------------------------------------------------------------------------

// One GUI hint string, shared by installClaude's notes and doctor's [claude]
// rows (audit F-004: two literals WILL drift). The desktop app has NO /plugin
// slash command — the + menu is the only install surface there.
const CLAUDE_DESKTOP_GUI_HINT =
  "desktop app: + button -> Plugins -> install panel-review, then restart the app";
// REMOVAL twin (Option B adversarial review, finding 1): the uninstall path
// printed the INSTALL hint — the only guidance a desktop user got during
// uninstall pointed the wrong direction. Separate constant, not an edit:
// the install hint is shared by installClaude and doctor.
const CLAUDE_DESKTOP_GUI_REMOVE_HINT =
  "desktop app: + button -> Plugins -> panel-review -> Uninstall, then restart the app";

/** Bounded EXECUTION probe (audit F-001/F-002): existence is not proof of
 *  function — the same Store-alias/broken-symlink class gitAvailable() guards
 *  against applies to claude candidates. Runs `<cli> --version` through the
 *  shell (npm-installed claude is a .cmd shim on Windows; CreateProcess can't
 *  launch those directly), piped stdio + hard timeout so a shim that launches
 *  and hangs cannot stall init. */
function cliRuns(cli) {
  try {
    execSync(cli + " --version", { stdio: "pipe", timeout: 10000, windowsHide: true });
    return true;
  } catch (e) {
    return false;
  }
}

/** INIT-CLAUDE-DESKTOP-FILE-INSTALL (2026-09-17), rung 2 of the install
 *  ladder: the native installer's documented locations, probed when `claude`
 *  is not on PATH — rescuing "CLI installed, PATH broken" machines. Candidate
 *  contract (audit F-003): a candidate counts only if it actually EXECUTES
 *  (`--version` probe) — broken symlinks (the native launcher is a symlink
 *  into a versions dir), Store-alias shims, and present-but-dead binaries are
 *  rejected; Homebrew paths are non-Windows only. Returns a runnable command
 *  string ("claude", or a quoted absolute path), or null. Paths resolve
 *  through mcpconf.homeDir() so the sandbox override holds. */
function findClaudeCli() {
  if (which("claude") && cliRuns("claude")) return "claude";
  const home = require("./mcpconf").homeDir();
  const candidates = process.platform === "win32"
    ? [path.join(home, ".local", "bin", "claude.exe")]
    : [path.join(home, ".local", "bin", "claude"),
       "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  for (const c of candidates) {
    try {
      fs.accessSync(c);
    } catch (e) {
      continue; /* not here */
    }
    // Platform-correct quoting (adversarial review minor): POSIX shells
    // expand $ and backticks inside DOUBLE quotes — a home path containing
    // them broke the probe. Single quotes are literal on POSIX; Windows cmd
    // needs double quotes.
    const quoted = process.platform === "win32"
      ? '"' + c + '"'
      : "'" + c.replace(/'/g, "'\\''") + "'";
    if (cliRuns(quoted)) return quoted;
  }
  return null;
}

function installClaude(gitOk) {
  const notes = [];
  // Rung 0 (INIT-GIT-PREFLIGHT): the marketplace is a git clone — without git
  // NOTHING below can work (the CLI's clone fails; a staged marketplace would
  // fail at app start too). Say so instead of pretending.
  if (gitOk === false) {
    notes.push("NOT installed — git is required (the plugin marketplace is a git clone,");
    notes.push("and Claude Code clones it with the system git).");
    notes.push("Install git (winget install Git.Git / git-scm.com), then re-run npx @truverifai/init.");
    return { installed: false, severity: "error", notes };
  }
  const cli = findClaudeCli();
  if (cli) {
    if (cli !== "claude") notes.push("claude CLI found off-PATH at " + cli);
    // Marketplace add is best-effort (a re-run may report it already exists);
    // the plugin install is what decides success.
    try {
      runCLI(cli + " plugin marketplace add https://github.com/TruVerifAI/claude-plugins.git");
    } catch (e) {
      notes.push("marketplace add skipped (" + String(e.message).slice(0, 120) + ")");
    }
    let installedOk = false;
    let installErr = null;
    try {
      runCLI(cli + " plugin install panel-review@truverifai");
      installedOk = true;
    } catch (e) {
      installErr = e;
    }
    // `plugin install` is initial-install-only: it does not UPGRADE an
    // existing install (its already-installed behavior — error vs no-op —
    // varies by CLI version, so don't branch on it). `plugin update`
    // refreshes the marketplace clone first (Claude Code >= 2.1.232) and
    // upgrades in place, which makes "re-run npx @truverifai/init" a
    // complete update on EVERY layer including the Claude plugin — the
    // route the update nudge sends people down. Best-effort: an older CLI
    // without the subcommand, or a fresh install already at latest, just
    // falls through on whatever the install attempt said.
    // Worst case both CLI calls block to their full 120s runCLI timeout —
    // acceptable for an interactive install step, but keep it two calls, max.
    let updatedOk = false;
    let updateErr = null;
    try {
      runCLI(cli + " plugin update panel-review@truverifai");
      updatedOk = true;
    } catch (e) {
      updateErr = e; /* older CLI / transient — the install attempt's answer stands */
    }
    if (installedOk || updatedOk) {
      // "or already present": some CLI versions exit 0 on an already-installed
      // plugin, and exit codes can't tell a fresh install from that no-op.
      notes.push((installedOk
        ? "installed (or already present) via claude CLI"
        : "already installed — updated to the marketplace's latest via claude CLI")
        + " — run /reload-plugins in open sessions, then set your key: /plugin -> panel-review -> api_token (or rely on ~/.truverifai/config.json)");
      if (installedOk && updatedOk) {
        notes.push("plugin reconciled with the marketplace's latest (claude plugin update)");
      }
      return { installed: true, notes };
    }
    const installMsg = (installErr && installErr.message) ? String(installErr.message).slice(0, 300) : "unknown error";
    const updateMsg = (updateErr && updateErr.message) ? String(updateErr.message).slice(0, 200) : "unknown error";
    notes.push("claude CLI present but install failed: " + installMsg);
    notes.push("(plugin update also failed: " + updateMsg + ")");
  }
  // Rung 3 (INIT-CLAUDE-DESKTOP-FILE-INSTALL): no runnable CLI — the desktop
  // app has NO /plugin command (GUI-only) and bundles no invocable binary, so
  // stage the MARKETPLACE via the existing guarded settings.json writer.
  // Claude Code registers/clones a user-level extraKnownMarketplaces entry at
  // next app start (documented), so panel-review then appears under
  // + -> Plugins ready to install — no URL to paste. enabledPlugins is
  // DELIBERATELY not written: for an external-source plugin it does not
  // install anything (documented, v2.1.195+) and would make doctor lie.
  const staged = require("./mcpconf").writeClaudeMarketplaceAutoUpdate();
  // Wording follows reality (adversarial review minor): rung 3 is reached
  // both when no CLI exists AND when a found CLI's install/update failed.
  const cliState = cli ? "claude CLI install failed" : "claude CLI not found";
  if (staged.installed) {
    notes.push(cliState + " — marketplace STAGED in ~/.claude/settings.json.");
    notes.push("Finish in Claude Code (one click):");
    notes.push("  " + CLAUDE_DESKTOP_GUI_HINT);
    notes.push("               (the MCP tools need a restart, not just a reload)");
    notes.push("  CLI users:   claude plugin install panel-review@truverifai");
    return { installed: false, staged: true, notes };
  }
  // Rung 4: could not stage either (usually: settings.json does not exist yet
  // — Claude Code owns it and we never create it). Platform-split manual steps;
  // the desktop app CANNOT run /plugin commands, so give it the GUI path.
  notes.push(cliState + " and the marketplace could not be staged"
    + (staged.notes && staged.notes.length ? " (" + String(staged.notes[0]).slice(0, 100) + ")" : "") + ".");
  notes.push("Finish in Claude Code:");
  notes.push("  desktop app: + button -> Plugins -> Add plugin -> paste");
  notes.push("               https://github.com/TruVerifAI/claude-plugins.git -> Install panel-review,");
  notes.push("               then restart the app.");
  notes.push("  CLI users:   claude plugin marketplace add https://github.com/TruVerifAI/claude-plugins.git");
  notes.push("               claude plugin install panel-review@truverifai   (then /reload-plugins)");
  return { installed: false, notes };
}

/** Backlog item 12: is panel-review already installed in codex's plugin
 *  cache? Same convention doctor's delivery row scans (verified empirically
 *  2026-07-31): ~/.codex/plugins/cache/<marketplace>/<plugin>@.../<version> */
function codexPluginInstalledInCache() {
  const cache = path.join(require("./mcpconf").homeDir(), ".codex", "plugins", "cache");
  try {
    for (const mkt of fs.readdirSync(cache)) {
      try {
        // Exact/prefix match, not substring (audit F-002): this boolean gates
        // a REMOVE, so a similarly named unrelated plugin must not trigger it.
        if (fs.readdirSync(path.join(cache, mkt)).some((n) => n === "panel-review" || n.startsWith("panel-review@"))) return true;
      } catch (e) {
        /* not a dir */
      }
    }
  } catch (e) {
    /* cache absent */
  }
  return false;
}

function installCodex() {
  const notes = [];
  if (which("codex")) {
    // 0.19.47 item 6 fix 2: repair an unloadable config BEFORE any
    // `codex plugin` command — a dangling [mcp_servers.truverifai.*]
    // subtable makes codex refuse to load its config, so the commands below
    // failed with "invalid transport" and the old remediation lines told the
    // user to run the same failing commands again (FW1, 2026-09-17).
    const loadable = require("./mcpconf").codexEnsureLoadable();
    if (loadable === "repaired") {
      notes.push("repaired ~/.codex/config.toml (dangling [mcp_servers."
        + "truverifai.*] subtable had made codex's config unloadable)");
    } else if (String(loadable).startsWith("ERROR")) {
      notes.push("config repair failed (" + loadable + ") — the codex commands below may fail to load configuration");
    }
    // Backlog item 12: codex has NO `plugin update` verb and `plugin add`
    // over an existing install keeps the OLD version, so re-running init
    // never bumped the installed plugin (0.18.5 seen against a current
    // snapshot). The proven refresh (2026-07-31 rounds) is remove + re-add.
    // Removing first is safe: the GATES run from the vendored user-level
    // hooks, not the plugin — only skills/MCP docs are briefly absent if
    // the re-add fails, and the failure note says how to finish.
    // Stated tradeoff (audit F-006): this runs on EVERY re-run while the
    // plugin is present — codex offers no version query, so a brief
    // remove/re-add is the price of a guaranteed bump.
    const hadPlugin = codexPluginInstalledInCache();
    if (hadPlugin) {
      try {
        runCLI("codex plugin remove panel-review@truverifai");
        notes.push("removed the installed plugin before refresh (codex has no update verb; remove + re-add is the bump)");
      } catch (e) {
        notes.push("pre-refresh plugin remove failed (" + cliErrReason(e) + ") — the add below may keep the currently installed version");
      }
    }
    // Marketplace add is best-effort: a re-run on a machine that already has
    // the marketplace may error ("already exists") and must not block the
    // plugin add, which is what decides success.
    try {
      runCLI("codex plugin marketplace add TruVerifAI/codex-plugins");
    } catch (e) {
      notes.push("marketplace add skipped (" + String(e.message).slice(0, 120) + ")");
      // Already-added marketplaces are SNAPSHOTS and `marketplace upgrade`
      // proved unreliable (2026-07-31): the definitive refresh is remove +
      // re-add. That is UNDOCUMENTED codex CLI behavior verified empirically
      // (audit F-003) — revisit if a future codex ships a real refresh verb.
      // Only an already-exists failure means a stale snapshot is present;
      // any OTHER failure (auth, network, malformed input) must NOT tear
      // down a working marketplace (audit F-001), so those keep the
      // non-destructive upgrade fallback.
      const failText = (String(e.message || "") + " " + String(e.stderr || "")).toLowerCase();
      let refreshed = false;
      let removed = false;
      if (/already|exist|duplicate/.test(failText)) {
        try {
          runCLI("codex plugin marketplace remove truverifai");
          removed = true;
          runCLI("codex plugin marketplace add TruVerifAI/codex-plugins");
          notes.push("marketplace snapshot refreshed (remove + re-add)");
          refreshed = true;
        } catch (e2) {
          if (removed) {
            // Removed but not restored (audit F-004): a temporarily broken
            // state, flagged louder than a routine best-effort skip.
            notes.push("WARNING: the truverifai marketplace was removed for the refresh but could NOT be re-added —");
            notes.push("restore it with: codex plugin marketplace add TruVerifAI/codex-plugins");
          }
        }
      }
      // Non-destructive fallback — skipped once the marketplace was removed
      // (upgrading a marketplace that no longer exists only stacks noise).
      if (!refreshed && !removed) {
        try {
          runCLI("codex plugin marketplace upgrade truverifai");
        } catch (e3) {
          notes.push("marketplace refresh also failed — if the add below fails, run `codex plugin marketplace remove truverifai` then re-run");
        }
      }
    }
    try {
      runCLI("codex plugin add panel-review@truverifai");
      notes.push(hadPlugin ? "reinstalled via codex CLI (fresh marketplace snapshot)" : "installed via codex CLI");
      return { installed: true, notes };
    } catch (e) {
      const msg = String(e.message);
      notes.push("codex CLI present but install failed: " + msg.slice(0, 300));
      if (hadPlugin) {
        notes.push("NOTE: the previously installed plugin was removed for the refresh —");
        notes.push("finish with: codex plugin add panel-review@truverifai");
        notes.push("(gates are unaffected: they run from the vendored hooks, not the plugin)");
      }
      // 0.19.47 item 6 fix 3: when codex cannot LOAD its own config, the
      // manual re-run advice below fails identically — say the true cause
      // and the fix instead of a dead-end loop.
      if (msg.indexOf("failed to load configuration") >= 0) {
        notes.push("codex could not load ~/.codex/config.toml itself — the manual");
        notes.push("commands below will fail the same way until the entry it names");
        notes.push("is fixed. Re-running `npx @truverifai/init` repairs the state");
        notes.push("this installer knows about ([mcp_servers.truverifai] subtables).");
      }
    }
  }
  notes.push("run: codex plugin marketplace add TruVerifAI/codex-plugins");
  notes.push("then: codex plugin add panel-review@truverifai");
  return { installed: false, notes };
}

/** 0.19.47 Option B (owner ruling, 2026-09-17): uninstall TRIES the host
 *  CLIs to remove the plugins init installed — best-effort and symmetric
 *  with install, which drives the same CLIs. Every attempt prints what
 *  happened; where no runnable CLI exists (the desktop app) the caller's
 *  manual note remains the path. A host-CLI failure NEVER fails the
 *  uninstall. Skipped wholesale under TVAI_HOME_OVERRIDE: host plugin state
 *  is real-machine state and has no sandbox. */
/** One-line, reason-first rendering of a host-CLI error (Option B review,
 *  finding 2): execSync's message starts with "Command failed: <cmdline>\n",
 *  which ate the whole 120-char budget and truncated away the actual reason
 *  ("Plugin ... not found in installed plugins") — and its embedded newlines
 *  broke the note indentation. Strip the echo, flatten, then slice. */
function cliErrReason(e) {
  return String(e && e.message || e)
    .replace(/^Command failed:[^\n]*\n?/, "")
    .replace(/\s*\n\s*/g, " ")
    .trim()
    .slice(0, 120);
}

function uninstallHostPlugins() {
  const notes = [];
  if (process.env.TVAI_HOME_OVERRIDE) {
    notes.push("host plugin removal SKIPPED (TVAI_HOME_OVERRIDE is set — sandbox mode)");
    return notes;
  }
  const fsMod = require("fs");
  const home = require("./mcpconf").homeDir();
  const cli = findClaudeCli();
  if (cli) {
    try {
      runCLI(cli + " plugin uninstall panel-review@truverifai");
      notes.push("claude plugin uninstalled (panel-review@truverifai)");
    } catch (e) {
      notes.push("claude plugin uninstall did not complete ("
        + cliErrReason(e) + ") — if it is installed, remove it via /plugin");
    }
    try {
      runCLI(cli + " plugin marketplace remove truverifai");
      notes.push("claude marketplace registration removed (truverifai)");
    } catch (e) {
      /* best-effort: absent registration errors here and needs no note */
    }
  } else if (fsMod.existsSync(require("path").join(home, ".claude"))) {
    // Only machines that HAVE Claude get the note (finding 4: a codex-only
    // machine got an irrelevant claude instruction) — and it is the REMOVAL
    // hint, not the install one (finding 1).
    notes.push("claude CLI not found — a desktop-app plugin install must be removed in the app ("
      + CLAUDE_DESKTOP_GUI_REMOVE_HINT + ")");
  }
  if (which("codex")) {
    try {
      runCLI("codex plugin remove panel-review@truverifai");
      // End-state phrasing (finding 3): codex exits 0 with the same message
      // whether the plugin existed or not, so an action claim ("removed")
      // would be false on machines that never had it.
      notes.push("codex reports panel-review absent/removed (panel-review@truverifai)");
    } catch (e) {
      notes.push("codex plugin remove did not complete ("
        + cliErrReason(e) + ") — run `codex plugin remove panel-review@truverifai` yourself if installed");
    }
    try {
      runCLI("codex plugin marketplace remove truverifai");
      notes.push("codex marketplace registration removed (truverifai)");
    } catch (e) {
      /* best-effort */
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// B. Config-file hosts
// ---------------------------------------------------------------------------

/** Copilot CLI + VS Code + Cloud Agent all read .github/hooks/*.json in the
 *  repo; user-level is ~/.copilot/hooks/. We write BOTH camelCase (CLI) —
 *  VS Code converts CLI configs itself. */
function installCopilot(cwd, scope, selection) {
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
      ? path.join(require("./mcpconf").homeDir(), ".copilot", "hooks")
      : path.join(cwd, ".github", "hooks");
  // Adversarial review 2026-09-17 finding 4: this twin used to write BOTH
  // files unconditionally, so `--only vscode` shipped a repo-committed
  // Copilot CLI gate whose tools were never connected (the T13 deny-with-no-
  // exit class, and a consent violation). `selection` picks which halves
  // land; omitted/null => both (every pre-B2 caller and `tvai hook`).
  // Explicit param, not arguments[] (audit F-001: opaque + arrow-refactor trap).
  const sel = selection || { copilot: true, vscode: true };
  const wrote = [];
  if (sel.copilot) {
    const target = path.join(dir, "truverifai-gate.json");
    writeJson(target, hook);
    wrote.push(target + " (Copilot CLI)");
  }
  if (sel.vscode) {
    const vstarget = path.join(dir, "truverifai-vscode.json");
    writeJson(vstarget, vshook);
    wrote.push(vstarget + " (VS Code agent)");
  }
  const who = [sel.copilot ? "Copilot CLI" : null, sel.vscode ? "VS Code agent" : null]
    .filter(Boolean).join(" + ");
  return {
    installed: wrote.length > 0,
    notes: [
      "hook config -> " + wrote.join(" + "),
      scope === "user"
        ? "applies to " + who + " for this user"
        : "applies to " + who + " for THIS repo. NOT the Cloud Agent: its sandbox honors only `bash` field hooks and has no vendored gates.",
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
  // Sandbox-aware home (finding 5) — same rule as installCodexHooks above.
  const p = path.join(require("./mcpconf").homeDir(), ".cursor", "hooks.json");
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
    "hook config -> " + p + " (user-level: covers the Cursor IDE agent AND the CLI, in every repo; the IDE agent delivers WRITE + commit gates (the write gate denies first); the CLI delivers the commit gate)",
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

/** The verbatim second line of the wrapper we write. Ownership is proved by
 *  THIS, never by the loose MARKER (audit mcp_89b329e9 F-001).
 *
 *  The installer used to guard with `existing.includes("truverifai")` while
 *  doctor and uninstall both used this strict signature. A hook the USER wrote
 *  that merely mentioned us — "# skip truverifai for release commits" — was
 *  therefore silently OVERWRITTEN by the installer, reported as "not ours" by
 *  doctor, and left behind by uninstall. Reproduced before fixing. With the
 *  gate now installed during a plain `init`, that would destroy user hooks on
 *  upgrade, so all three call sites must agree on one strict test. */
const PRECOMMIT_SIGNATURE = "truverifai pre-commit commit gate";

function installGitPrecommit(cwd) {
  const root = gitRepoRoot(cwd);
  if (!root) {
    return { installed: false, notes: ["not a git repo — skipped pre-commit hook"] };
  }
  // In a linked WORKTREE or a SUBMODULE, `.git` is a FILE pointing elsewhere,
  // so <root>/.git/hooks is not a directory and never will be — git dispatches
  // hooks from the main repo's git dir instead. The write below then fails with
  // a bare "could not write ...ENOTDIR", which tells the user nothing. Say what
  // is actually going on and where to run it instead, rather than leaving them
  // to decode an errno (audit mcp_91b231a8 F-001).
  let gitFile = null;   // the gitfile's contents, or null when .git is a directory
  try {
    const dotGit = path.join(root, ".git");
    if (fs.statSync(dotGit).isFile()) gitFile = fs.readFileSync(dotGit, "utf8");
  } catch (e) {
    /* absent, vanished mid-run, or unreadable — the normal write path reports it */
  }
  if (gitFile !== null) {
    // WHICH kind matters, because the remedy differs and getting it wrong sends
    // the user somewhere that will not gate them (audit mcp_954f30f4 F-001):
    //   worktree  -> gitdir is <main>/.git/worktrees/<name>, and git dispatches
    //                hooks from the COMMON dir, so a hook in the main checkout
    //                DOES fire for commits made here (verified by experiment).
    //   submodule -> gitdir is <parent>/.git/modules/<name>, which has its own
    //                hooks; the parent's hooks do NOT fire on its commits, so
    //                "run it in the parent" would be false advice.
    const isWorktree = /[/\\]worktrees[/\\]/.test(gitFile);
    const isSubmodule = /[/\\]modules[/\\]/.test(gitFile);
    const why = root + "/.git is a file, not a directory, so this checkout's "
      + "hooks live elsewhere in the git directory and a hook written here "
      + "would never fire.";
    return {
      installed: false,
      notes: isWorktree
        ? ["this is a linked worktree — " + why,
           "run `npx @truverifai/init hook` in the MAIN checkout instead: git "
             + "dispatches hooks from the shared git directory, so that one "
             + "covers commits made from this worktree too."]
        : isSubmodule
          ? ["this is a submodule — " + why,
             "a hook in the parent repo will NOT gate commits made in here (a "
              + "submodule has its own git directory and its own history). "
              + "Gating submodule commits is not supported yet."]
          : ["this checkout's .git is a file rather than a directory — " + why,
             "installing the pre-commit gate is not supported in this layout."],
    };
  }
  const hookDir = path.join(root, ".git", "hooks");
  const target = path.join(hookDir, "pre-commit");
  const gate = gatesPath("audit_gate.py").replace(/\\/g, "/");
  // Item 12 (round 3, Mac/Gemini MO7): the hook used to be a FIFTH interpreter
  // searcher with its own rules — no record, no heal, and every non-deny
  // failure was a SILENT allow (a python2 `python` passes `-c ""` and then
  // chokes on the gate; an exhausted loop allowed with zero output; a
  // CLT-less Mac's /usr/bin/python3 stub could hang the commit behind a GUI
  // dialog). It now runs the shared launcher — one searcher, one record,
  // everywhere — and every fail-open path prints WHY to git's own stderr,
  // the one channel a hook user is guaranteed to see.
  // Absolute path by design (audit mcp_9e0da2ce F-003): every delivery on
  // this machine keys off ~/.truverifai — a moved home/prefix breaks them
  // all identically, the hook then prints its loud NOT-gated line (never a
  // silent allow), and `npx @truverifai/init@latest` is the one-step repair.
  // The env export below is a deliberate belt: the launcher forwards
  // TVAI_PLATFORM from its argv to the gate child, and the export keeps the
  // gate correctly host-labeled even under a launcher that failed to (F-004).
  const launcher = gatesPath("run_gate.js").replace(/\\/g, "/");
  const script =
    "#!/bin/sh\n" +
    "# truverifai pre-commit commit gate (installed by tvai; edit source, not this)\n" +
    "# Runs the shared launcher (interpreter record + self-heal + honest give-ups).\n" +
    "# Deny = exit 21 -> block; ANY other outcome fails OPEN — loudly, never silently.\n" +
    'TVAI_PLATFORM=git_precommit\n' +
    "export TVAI_PLATFORM\n" +
    'LAUNCHER="' + launcher + '"\n' +
    'if [ ! -f "$LAUNCHER" ]; then\n' +
    '  echo "TruVerifAI: this commit was NOT gated — gate code missing ($LAUNCHER). Fix: npx @truverifai/init@latest" >&2\n' +
    "  exit 0\n" +
    "fi\n" +
    "if ! command -v node >/dev/null 2>&1; then\n" +
    '  echo "TruVerifAI: this commit was NOT gated — node not found (every gate delivery needs it). Fix: install node, then npx @truverifai/init@latest" >&2\n' +
    "  exit 0\n" +
    "fi\n" +
    'node "$LAUNCHER" git_precommit audit_gate.py < /dev/null\n' +
    "rc=$?\n" +
    "if [ $rc -eq 21 ]; then exit 1; fi\n" +
    "if [ $rc -ne 0 ]; then\n" +
    '  echo "TruVerifAI: this commit was NOT gated — the launcher exited $rc. Fix: npx @truverifai/init@latest" >&2\n' +
    "fi\n" +
    "exit 0\n";
  let existing = "";
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch (e) {
    /* none */
  }
  // STRICT ownership test — see PRECOMMIT_SIGNATURE. Anything else is the
  // user's and is never touched.
  const isOurs = existing.includes(PRECOMMIT_SIGNATURE);
  if (existing && !isOurs) {
    return {
      installed: false,
      notes: [
        "a pre-commit hook already exists at " + target + " — not overwriting.",
        // Mac A10: this said `python`, which does not exist on macOS 12.3+ or on
        // Debian/Ubuntu without python-is-python3 — the exact regression class R5
        // exists to catch, surviving in the refusal path's copy.
        "add manually:  TVAI_PLATFORM=git_precommit node \"" + gatesPath("run_gate.js").replace(/\\/g, "/") + "\" git_precommit audit_gate.py </dev/null; [ $? -eq 21 ] && exit 1 || true",
      ],
    };
  }
  // The write is the only part of init that touches .git/. A read-only or
  // permission-denied hooks dir (CI, shared checkouts) must not take the whole
  // install down with it — every installer returns a result, none throw
  // (audit F-002).
  try {
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(target, script, { encoding: "utf8", mode: 0o755 });
  } catch (e) {
    return {
      installed: false,
      notes: ["could not write " + target + " (" + String(e.message).slice(0, 90)
        + ") — the git pre-commit gate is NOT installed here."],
    };
  }
  try {
    // Load-bearing on POSIX: git SILENTLY IGNORES a non-executable hook, which
    // would make this gate dead in exactly the way X1 was. No-op on Windows.
    fs.chmodSync(target, 0o755);
  } catch (e) {
    /* windows */
  }
  const notes = [(isOurs ? "git pre-commit commit gate UPDATED -> "
                         : "git pre-commit commit gate -> ") + target +
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
  // Every repo-scoped path below is relative to the repo ROOT, because that is
  // where the installers wrote them. Resolving it here (rather than trusting the
  // caller's cwd) means `uninstall` from a subdirectory still finds them — it
  // used to leave the pre-commit gate and the repo hook configs behind and say
  // nothing about it, which reads as a clean uninstall (X11c).
  cwd = gitRepoRoot(cwd) || cwd;
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
  uninstallHostPlugins,
  installGateCode,
  recoverGateDirs,
  verifyStaged,
  recordInterpreter,
  runSelfCheck,
  installClaude,
  findClaudeCli,
  CLAUDE_DESKTOP_GUI_HINT,
  installCodex,
  installCodexHooks,
  installAntigravity,
  installCopilot,
  installCursor,
  installGemini,
  installGitPrecommit,
  gatesPath,
};
