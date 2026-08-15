// `tvai doctor` — the only honest answer to "are the gates actually on?"
// (implementation plan §3.4). Checks are ranked by how end-to-end they are;
// the synthetic gate fire is the one that PROVES enforcement.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execSync } = require("child_process");

const api = require("./api");
const config = require("./config");
const { detect } = require("./detect");
const { gatesPath, MARKER } = require("./hosts");
const mcpconf = require("./mcpconf");
const gates = require("./gates");

/** X6 (2026-08-14): the order used to be py, python, python3 — `python` BEFORE
 *  `python3`. Where /usr/bin/python is still Python 2 (RHEL/CentOS 7, Amazon
 *  Linux 2, Debian with python-is-python2, older container images) the probe
 *  `python -c ""` succeeds, doctor selected Python 2, the gate's f-strings blew
 *  up with a SyntaxError, and doctor reported "gate exited 1 (must be 0)"
 *  against a perfectly healthy gate — a false red on the product's primary
 *  trust surface. No gate was ever affected: run_gate.sh and run_gate.js both
 *  reach python3 first. This aligns doctor with run_gate.js.
 *
 *  The probe also ASSERTS major version 3 rather than merely "it starts", so a
 *  py2 interpreter can never be selected by any ordering. `py` stays first: on
 *  Windows it is the reliable launcher, and it is a py3 launcher everywhere it
 *  exists. */
function pyExe() {
  for (const c of ["py", "python3", "python"]) {
    const r = spawnSync(c, ["-c", "import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)"],
                        { stdio: "pipe" });
    if (r.status === 0) return c;
  }
  return null;
}

/** Is `node` on PATH, and which version? Returns the version string or null.
 *  Load-bearing: EVERY host's hook command is `node <launcher> <host> <gate>`,
 *  so no node means no gates anywhere — silently, because a hook that cannot
 *  start is a non-blocking error on most hosts. */
function nodeExe() {
  try {
    const r = spawnSync("node", ["--version"], { stdio: "pipe", encoding: "utf8" });
    if (r.status === 0) return String(r.stdout || "").trim();
  } catch (e) {
    /* not on PATH */
  }
  return null;
}

/** The synthetic risky Edit both gate probes use — a removed permission check,
 *  which the classifier scores as a hard floor. ONE payload so the direct-python
 *  row and the launcher row prove the same thing about the same input. */
function syntheticEditPayload() {
  return JSON.stringify({
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(process.cwd(), "auth_check.py"),
      old_string: "if not user.has_permission(resource):\n    raise Forbidden()",
      new_string: "# permission check removed\npass",
    },
    cwd: process.cwd(),
    session_id: "tvai-doctor",
  });
}

/** Interpret a finished gate process as {armed, detail}. Shared by both probes
 *  so they cannot drift in what counts as a deny. */
function readGateResult(r, label) {
  if (r.error) {
    return { armed: false, detail: label + " failed to start: " + String(r.error.message).slice(0, 80) };
  }
  if (r.status !== 0) {
    return { armed: false, detail: label + " exited " + r.status + " (must be 0)" };
  }
  const out = (r.stdout || "").trim();
  const err = r.stderr || "";
  if (err.includes("TVAI_GATE_MISCONFIGURED")) {
    return { armed: false, detail: "platform misconfigured: " + err.split("\n")[0] };
  }
  try {
    const j = JSON.parse(out);
    const d =
      (j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision) ||
      j.permissionDecision ||
      j.permission ||
      j.decision;
    if (d === "deny" || d === "block") return { armed: true, detail: null };
    return { armed: false, detail: "gate allowed the synthetic risky edit (decision=" + d + ")" };
  } catch (e) {
    return { armed: false, detail: "no deny JSON on stdout (allowed): " + out.slice(0, 80) };
  }
}

/** Run the REAL write gate with a synthetic risky Edit and assert it denies.
 *  Entirely local except the coverage POST (which uses the caller's key and
 *  sends only the probe's own hunk hashes). Returns {armed, detail}.
 *
 *  This proves the gate CODE is healthy. It does NOT prove a host can reach it
 *  — see launcherFire(). */
function syntheticFire(platform, apiKeyVal) {
  const py = pyExe();
  if (!py) return { armed: false, detail: "no working python found" };
  const gate = gatesPath("deliberate_gate.py");
  if (!fs.existsSync(gate)) {
    return { armed: false, detail: "gate code not installed (run tvai init)" };
  }
  const r = spawnSync(py, [gate], {
    input: syntheticEditPayload(),
    encoding: "utf8",
    timeout: 60000,
    env: Object.assign({}, process.env, {
      TVAI_PLATFORM: platform,
      TVAI_API_KEY: apiKeyVal || "",
    }),
  });
  const res = readGateResult(r, "gate");
  return res.armed
    ? { armed: true, detail: "synthetic risky edit was DENIED (gate armed)" }
    : res;
}

/** Run the write gate THROUGH THE VENDORED LAUNCHER — the layer the
 *  config-file hosts' hook commands invoke, and a layer syntheticFire() has
 *  never touched.
 *
 *  X2 (2026-08-14): doctor spawned the gate's python DIRECTLY, so the launcher
 *  was invisible to it. That is how X1 shipped — a non-executable run_gate.sh
 *  killed every gate on macOS/Linux while doctor reported a green synthetic
 *  fire on the same machine. This row closes that blind spot for the
 *  absolute-path delivery shape, and makes the node-on-PATH dependency visible
 *  instead of silent.
 *
 *  There are TWO launcher copies and they are separate artifacts (audit
 *  mcp_5877e029 F-001): the one `tvai init` vendors to
 *  ~/.truverifai/gates/current for the config-file hosts, and the one inside
 *  Claude Code's plugin cache that ${CLAUDE_PLUGIN_ROOT} resolves to. A green
 *  row for one says NOTHING about the other, so each gets its own probe and its
 *  own honestly-scoped label.
 *
 *  TVAI_PLATFORM is deliberately NOT set: the launcher must derive it from its
 *  own argv, exactly as the hook command does. Setting it would mask a launcher
 *  that drops the host argument (the silent-no-op failure mode). */
function fireThroughLauncher(launcher, platform, apiKeyVal) {
  if (!fs.existsSync(launcher)) {
    return { armed: false, detail: "launcher missing: " + launcher };
  }
  if (!nodeExe()) {
    return {
      armed: false,
      detail: "node is NOT on PATH, so the hook command form `node <launcher> " +
        "<host> <gate>` cannot start — every gate would fail OPEN, silently. " +
        "Install Node 18+.",
    };
  }
  const r = spawnSync("node", [launcher, platform, "deliberate_gate.py"], {
    input: syntheticEditPayload(),
    encoding: "utf8",
    timeout: 60000,
    env: Object.assign({}, process.env, { TVAI_API_KEY: apiKeyVal || "" }),
  });
  return readGateResult(r, "launcher");
}

/** The VENDORED launcher — what Codex, Cursor, Copilot, VS Code, Gemini and
 *  Antigravity hook configs point at (absolute path under ~/.truverifai). */
function launcherFire(platform, apiKeyVal) {
  const res = fireThroughLauncher(gatesPath("run_gate.js"), platform, apiKeyVal);
  if (!res.armed) {
    return res.detail.startsWith("launcher missing")
      ? { armed: false, detail: res.detail + " (run tvai init)" }
      : res;
  }
  return { armed: true, detail: "vendored launcher armed: `node run_gate.js "
    + platform + " deliberate_gate.py` produced a DENY (the hook command form "
    + "used by Codex / Cursor / Copilot / VS Code / Gemini / Antigravity)" };
}

/** The CLAUDE PLUGIN-CACHE launcher — the file ${CLAUDE_PLUGIN_ROOT} actually
 *  resolves to, executing that bundle's OWN gate chain (its gate_lib, its
 *  classifier). This is the only row that proves Claude Code's delivery path
 *  end to end; claudeInstalledHookRow() verifies the same bundle statically.
 *
 *  NEVER returns null (audit mcp_d7ff37ae F-001). The first draft skipped the
 *  row when no unambiguous bundle was found, reasoning that the static row
 *  already reported it. That is an implicit cross-row dependency with nothing
 *  enforcing it — an absent row reads to a user exactly like a passing one,
 *  which is a false green by omission, the same species of assumption that let
 *  X1 ship. Instead the unprobed case says so, as a warn: not a failure (it
 *  must not flip doctor's exit code on a machine that simply has no marketplace
 *  install), but never invisible. */
function claudeLauncherFire(apiKeyVal) {
  const b = activeClaudeBundle();
  if (!b.root) {
    return {
      armed: false,
      warn: true,
      detail: b.candidates.length
        ? "NOT probed — " + b.candidates.length + " non-orphaned Claude bundles "
          + "present (" + b.candidates.map((d) => path.basename(d)).join(", ")
          + "), so which one Claude Code loads is unknown"
        : "NOT probed — no Claude marketplace bundle found on disk (the plugin "
          + "may be installed another way; see the [claude] delivery rows)",
    };
  }
  const launcher = path.join(b.root, "hooks", "run_gate.js");
  const v = path.basename(b.root);
  if (!fs.existsSync(launcher)) {
    return { armed: false, detail: "installed Claude bundle v" + v
      + " has no hooks/run_gate.js — its hook commands cannot start. "
      + "Reinstall: /plugin install panel-review@truverifai" };
  }
  const res = fireThroughLauncher(launcher, "claude_code", apiKeyVal);
  return res.armed
    ? { armed: true, detail: "installed Claude bundle v" + v + " armed: `node "
        + "\"${CLAUDE_PLUGIN_ROOT}/hooks/run_gate.js\" claude_code "
        + "deliberate_gate.py` produced a DENY (Claude Code's real hook path)" }
    : { armed: false, detail: "installed Claude bundle v" + v + ": " + res.detail
        + " — Claude Code's hook path is NOT enforcing" };
}

/** Which config source resolves the key — the #1 confusion with a 3-level chain. */
function keySource() {
  if ((process.env.TVAI_API_KEY || "").trim()) return "TVAI_API_KEY env var";
  const cfg = config.read();
  if ((cfg.api_key || cfg.api_token || "").trim()) return config.FILE;
  return null;
}

/** GATE DELIVERY checks — is the thing that INVOKES the gate actually in
 *  place per host? The 2026-07-31 miss: codex's plugin install had failed
 *  while doctor showed all green, because the synthetic fires prove the gate
 *  CODE and the tools rows prove the MCP config, but no row owned "is the
 *  hook-carrying plugin/config installed?". Never green on uncertainty. */
/** Effective-cwd drift alarm: run the real commit gate (audit_gate) with a
 *  synthetic workdir-arg payload and a cd-chain payload against a fresh
 *  parent/child repo pair in a temp dir; TVAI_PAYLOAD_LOG is the oracle for
 *  which repo the resolver actually inspected. Fail-open remains untouched —
 *  a ✗ here means detection drift, not blocked work. */
function nestedRepoCheck(apiKeyVal) {
  const py = pyExe();
  if (!py) return { ok: false, detail: "nested-repo check skipped: no working python" };
  const gate = gatesPath("audit_gate.py");
  if (!fs.existsSync(gate)) {
    return { ok: false, detail: "nested-repo check skipped: gate code not installed" };
  }
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tvai-nested-"));
    const parent = path.join(tmp, "parent");
    const child = path.join(parent, "child");
    for (const d of [parent, child]) {
      fs.mkdirSync(d, { recursive: true });
      const r = spawnSync("git", ["init", "-q"], { cwd: d, stdio: "pipe", timeout: 20000 });
      if (r.status !== 0) return { ok: false, detail: "nested-repo check skipped: git init failed" };
    }
    const log = path.join(tmp, "resolve.jsonl");
    // Stage a genuinely risky file in the CHILD so the workdir-routed commit
    // must produce a real DENY, not just a resolver log line (audit
    // mcp_91d0001f F-002: "resolved the child" and "denied the commit" are
    // different assertions — this row makes both).
    const mig = path.join(child, "migrations");
    fs.mkdirSync(mig, { recursive: true });
    fs.writeFileSync(path.join(mig, "999_doctor_probe.sql"), "DROP TABLE users_doctor_probe;\n");
    spawnSync("git", ["add", "-A"], { cwd: child, stdio: "pipe", timeout: 20000 });
    const probes = [
      ["workdir arg", { command: "git commit -m tvai-doctor-probe", workdir: child }],
      ["cd-chain", { command: "cd child && git commit -m tvai-doctor-probe" }],
    ];
    let denied = false;
    for (const [label, toolInput] of probes) {
      const r = spawnSync(py, [gate], {
        input: JSON.stringify({
          tool_name: "Bash", tool_input: toolInput, cwd: parent,
          session_id: "tvai-doctor-nested",
        }),
        encoding: "utf8", timeout: 60000,
        env: Object.assign({}, process.env, {
          TVAI_PLATFORM: "claude_code",
          TVAI_API_KEY: apiKeyVal || "",
          TVAI_PAYLOAD_LOG: log,
        }),
      });
      if (r.status !== 0) return { ok: false, detail: "nested-repo check: gate exited " + r.status };
      if ((r.stdout || "").includes('"deny"')) denied = true;
    }
    const events = fs.readFileSync(log, "utf8").trim().split("\n")
      .map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } })
      .filter((e) => e.event === "resolve_effective_cwd");
    const childNorm = child.toLowerCase().replace(/\\/g, "/");
    const hit = (src) => events.some((e) =>
      e.cwd_source === src &&
      String(e.resolved || "").toLowerCase().replace(/\\/g, "/") === childNorm);
    if (hit("dir_arg") && hit("cd_chain")) {
      // The deny half is server-dependent: with a working key + reachable
      // server a workdir-routed risky commit must DENY; offline the gate
      // fails open by design, so resolution health is still reported but
      // the deny is called out as unverified.
      return { ok: true, detail: denied
        ? "nested-repo commits resolve to the CHILD repo AND the risky child commit was DENIED (workdir arg + cd-chain) — effective-cwd enforcement healthy"
        : "nested-repo commits resolve to the CHILD repo (workdir arg + cd-chain); deny not observed (server unreachable or fail-open) — resolution healthy, enforcement unverified" };
    }
    return { ok: false, detail: "nested-repo resolution DRIFTED: the commit gate did not resolve the child repo (dir_arg=" + hit("dir_arg") + ", cd_chain=" + hit("cd_chain") + ") — a workdir-routed commit may be mis-gated against the session root; report this" };
  } catch (e) {
    return { ok: false, detail: "nested-repo check errored: " + String(e.message).slice(0, 60) };
  } finally {
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}


/** Are the gates actually switched on, and for WHICH deliveries? (X8)
 *
 *  Doctor used to report one thing here: the Claude /plugin toggle. That is a
 *  single level of a three-level chain, and it is the only level that is
 *  HOST-SCOPED — it reaches the hooks Claude Code spawns and nothing else. So a
 *  user could turn it off, see doctor agree, and still be blocked by the git
 *  pre-commit hook or by Cursor/Codex/Copilot/Gemini, with no surface anywhere
 *  saying a second gate was armed (the 2026-08-14 incident).
 *
 *  These rows report the EFFECTIVE state per delivery group, name the level that
 *  decided it, and call out the split explicitly when the two disagree.
 *
 *  Severity choice: an intentional OFF is a `warn`, not a `bad`. A user who ran
 *  `tvai gates off` is not in a failure state, and making doctor exit 1 forever
 *  would train people to ignore its exit code. `bad` stays reserved for broken,
 *  not chosen. (This is a deliberate change from the old row, which was `bad`.) */
function gateStateRows(ok, warn) {
  const s = gates.state();
  const rows = [];
  const onoff = (b) => (b ? "ON" : "OFF");
  const line = (label, val, src) =>
    (val ? ok : warn)("gates " + onoff(val) + " — " + label + "  [" + src + "]");

  // Scope language only — never a LIST of deliveries (X11b). The old text
  // named "git pre-commit hook, Codex, Cursor, …" here, which reads as what is
  // installed rather than what this setting governs, and said so even on a
  // machine where the git gate was absent. What is actually installed is the
  // job of the delivery rows further down.
  if (!s.split) {
    rows.push(line("every delivery on this machine", s.universal, s.universalSource));
  } else {
    // The X8 shape. Name both halves and which one the user probably forgot.
    rows.push(line("Claude Code hooks", s.claudeHooks, s.claudeSource));
    rows.push(line("every host other than Claude Code", s.universal,
      s.universalSource));
    rows.push(warn("  ^ these DISAGREE. The Claude /plugin toggle governs Claude "
      + "Code's own hooks only — it cannot reach the git hook or any other host. "
      + "One switch for everything: `tvai gates off` (or `on`)."));
  }
  if (s.env !== null) {
    rows.push(warn("  " + gates.ENV_VAR + " is exported in this environment and "
      + "overrides every other level — including `tvai gates on|off`, which "
      + "writes the config file beneath it."));
  }
  return rows;
}


/** Claude Code is the ONE host that delivers gates through the plugin's own
 *  hooks.json, so those command strings are load-bearing in a way no other
 *  host's are — and nothing verified them until X1 (2026-08-14) shipped a bare
 *  `.sh` invocation that died "Permission denied" on every Mac.
 *
 *  Reads the ACTIVE installed bundle (Claude Code marks superseded cache
 *  versions with `.orphaned_at`; the one without it is what a new session
 *  loads) and asserts every command names a file that exists and is invocable.
 *  Returns null when the plugin is not installed from the marketplace cache —
 *  there is simply nothing to verify, which is not a failure.
 *
 *  SCOPE (audit mcp_5877e029 F-006): this inspects the installed bundle on
 *  disk, NOT whatever a running session is holding. Claude Code refcounts
 *  in-use versions, so a session that started before an update can still be
 *  executing an older bundle than the one checked here.
 *
 *  AMBIGUITY IS NOT GREEN (F-002): `readdirSync` has no ordering guarantee, and
 *  two non-orphaned versions can legitimately coexist during an update. Picking
 *  one by directory order would certify a guess — and a guess that lands on the
 *  clean bundle while the broken one is live is exactly the false green this
 *  row exists to prevent. So >1 candidate reports the ambiguity instead. */
function activeClaudeBundle() {
  const base = path.join(os.homedir(), ".claude", "plugins", "cache");
  const candidates = [];
  try {
    for (const mkt of fs.readdirSync(base)) {
      const pdir = path.join(base, mkt, "panel-review");
      if (!fs.existsSync(pdir)) continue;
      for (const v of fs.readdirSync(pdir)) {
        const d = path.join(pdir, v);
        if (!fs.existsSync(path.join(d, ".orphaned_at")) &&
            fs.existsSync(path.join(d, "hooks.json"))) {
          candidates.push(d);
        }
      }
    }
  } catch (e) {
    /* no cache dir — not a marketplace install */
  }
  return { root: candidates.length === 1 ? candidates[0] : null, candidates };
}

/** Problems in one installed bundle's hooks.json: a bare `.sh` command (needs
 *  the POSIX exec bit, so it is dead on macOS/Linux) or a command whose target
 *  file is missing. Shared by the ambiguous-bundle branch and the
 *  single-bundle branch so the two cannot disagree about what "broken" means.
 *  Never throws. */
function hookProblems(root) {
  let hk;
  try {
    hk = JSON.parse(fs.readFileSync(path.join(root, "hooks.json"), "utf8"));
  } catch (e) {
    return ["hooks.json missing or invalid JSON"];
  }
  const problems = [];
  for (const groups of Object.values((hk && hk.hooks) || {})) {
    for (const grp of groups || []) {
      for (const entry of grp.hooks || []) {
        const cmd = String(entry.command || "");
        const m = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}([^"'\s]*)/);
        if (!m) continue;
        const rel = m[1].replace(/^[\/]+/, "");
        if (/^\s*(["']?)\$\{CLAUDE_PLUGIN_ROOT\}/.test(cmd) && /\.sh\b/.test(cmd)) {
          problems.push("bare .sh, needs an exec bit: " + rel);
        }
        if (!fs.existsSync(path.join(root, rel))) problems.push("target missing: " + rel);
      }
    }
  }
  return problems;
}

function claudeInstalledHookRow(ok, bad, warn) {
  const { root, candidates } = activeClaudeBundle();
  if (!candidates.length) return null;
  if (!root) {
    // Ambiguous — we cannot say WHICH bundle Claude Code will load. Severity
    // depends on whether that ambiguity is dangerous:
    //
    //  - all candidates healthy -> WARN. Just a plugin update with an old
    //    session still holding the previous version; resolves on restart.
    //    Exiting 1 here would false-alarm every user who updates without
    //    restarting, which is most of them.
    //  - ANY candidate broken -> BAD. Claude Code might be loading that one, so
    //    the user may be unprotected right now. Exactly the state the
    //    2026-08-15 Windows round was in: 0.19.31 (six bare .sh commands, dead
    //    on POSIX) beside a fixed 0.19.32. A blanket warn there would exit 0
    //    over a possibly-dead gate.
    const broken = candidates.filter((d) => hookProblems(d).length);
    const names = candidates.map((d) => path.basename(d)).join(", ");
    if (broken.length) {
      return bad("[claude] cannot determine the active plugin bundle — "
        + candidates.length + " non-orphaned versions present (" + names
        + "), and " + broken.map((d) => "v" + path.basename(d)).join(", ")
        + " has BROKEN hook commands. Claude Code may be loading that one, so "
        + "the gates may not be enforcing. Restart Claude Code so the old "
        + "bundle is released, then re-run.");
    }
    return warn("[claude] cannot determine the active plugin bundle — "
      + candidates.length + " non-orphaned versions present (" + names
      + "). Hook commands NOT verified, though all candidates look healthy — "
      + "normal right after a plugin update: restart Claude Code so the old "
      + "bundle is released, then re-run.");
  }
  const problems = hookProblems(root);
  const v = path.basename(root);
  if (!problems.length) {
    return ok("[claude] installed hooks.json commands all resolve (v" + v + ")");
  }
  // Dedupe + cap: the same defect usually repeats across every hook entry, and
  // one unreadable 6-clause line is worse than a named count.
  const uniq = Array.from(new Set(problems));
  const shown = uniq.slice(0, 3).join("; ")
    + (uniq.length > 3 ? " (+" + (uniq.length - 3) + " more)" : "");
  return bad("[claude] installed hooks.json v" + v + " — " + problems.length
    + " bad command(s): " + shown
    + ". Reinstall the plugin (/plugin install panel-review@truverifai) or run "
    + "npx @truverifai/init@latest.");
}


/** Is the git pre-commit gate installed in THIS repo? (X11a)
 *
 *  Every other delivery has a presence row; this one had none, so it was
 *  invisible whether installed or not — and it is the only layer that catches a
 *  `git commit` typed outside any agent, and the only bypass-resistant one.
 *
 *  WARN, never BAD: a repo without it is a legitimate state (you may only want
 *  it in some repos), and it is repo-scoped so `doctor` run elsewhere says
 *  nothing about the repo you care about. */
function gitPrecommitRow(ok, bad, warn, cwd) {
  const p = path.join(cwd, ".git", "hooks", "pre-commit");
  if (!fs.existsSync(path.join(cwd, ".git"))) return null;   // not a repo
  let text = "";
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    return warn("[git] no pre-commit gate in this repo — commits made outside "
      + "an agent are NOT gated here. Add it: npx @truverifai/init hook");
  }
  if (text.includes("truverifai pre-commit commit gate")) {
    // The wrapper existing is NOT the same as the gate working. It invokes
    // audit_gate.py by ABSOLUTE path, so an uninstall, a moved home directory
    // or a wiped ~/.truverifai leaves a wrapper that runs, finds nothing, and
    // exits 0 — a commit that looks gated and is not. Reporting ✓ on the
    // wrapper alone would be a false green of exactly the kind this series
    // keeps producing (audit mcp_89b329e9 F-004).
    const m = text.match(/"([^"]*audit_gate\.py)"/);
    if (!m) {
      return warn("[git] a pre-commit gate is installed here but its gate path "
        + "could not be read — reinstall with: npx @truverifai/init hook");
    }
    if (!fs.existsSync(m[1])) {
      return bad("[git] the pre-commit gate points at missing gate code ("
        + m[1] + ") — it runs, finds nothing and exits 0, so commits here are "
        + "NOT gated. Fix: npx @truverifai/init");
    }
    return ok("[git] pre-commit gate installed in this repo (catches commits "
      + "made outside any agent; bypass with --no-verify)");
  }
  return warn("[git] this repo has a pre-commit hook we did not write — left "
    + "alone, so commits outside an agent are NOT gated here. Add ours "
    + "manually, or see `npx @truverifai/init hook` for the line.");
}


function claudeDeliveryRows(ok, bad, warn) {
  const rows = [];
  const p = path.join(os.homedir(), ".claude", "settings.json");
  try {
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    const state = (s.enabledPlugins || {})["panel-review@truverifai"];
    if (state === true) {
      rows.push(ok("[claude] plugin installed + enabled (gate delivery)"));
    } else if (state === false) {
      rows.push(bad("[claude] plugin installed but DISABLED — /plugin -> enable panel-review, then /reload-plugins"));
    } else {
      rows.push(bad("[claude] plugin NOT installed — Claude Code has no gates/skills. Run npx @truverifai/init, or inside Claude Code: /plugin install panel-review@truverifai"));
    }
    // (the enable_gates toggle is reported by gateStateRows() instead — it is
    // one level of a three-level chain, and reporting it alone was exactly the
    // X8 confusion: it governs Claude Code's own hooks and nothing else.)
    // CC 2.1.221+ auto-mode classifier (2026-08-04): without an explicit
    // permissions.allow rule for our MCP server, it denies the skip/defer
    // tools host-side (intent-shaped: they look like "skip a safety
    // review"). init writes the rule; warn when it's missing.
    const allow = ((s.permissions || {}).allow) || [];
    if (Array.isArray(allow) && allow.indexOf(mcpconf.CLAUDE_MCP_ALLOW_RULE) === -1) {
      rows.push(warn("[claude] auto-mode allowlist missing — Claude's permission classifier may deny record_gate_skip/defer calls. Re-run npx @truverifai/init (or /permissions -> allow " + mcpconf.CLAUDE_MCP_ALLOW_RULE + "), then start a NEW Claude session — the rule does not apply to sessions already open"));
    }
  } catch (e) {
    rows.push(warn("[claude] can't read ~/.claude/settings.json — plugin install state unverified"));
  }
  return rows;
}

function codexFeatureFlagRow(ok, bad) {
  // Codex hooks are OFF by default: without [features] codex_hooks = true in
  // ~/.codex/config.toml the plugin's gates are SILENT no-ops (no error, no
  // log — docs review 2026-07-31). init writes it; this row catches configs
  // where it's still missing.
  const p = path.join(os.homedir(), ".codex", "config.toml");
  let text = "";
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    /* absent -> the delivery row below already covers "not installed" */
    return null;
  }
  if (/(^\s*hooks\s*=\s*true)|codex_hooks\s*=\s*true/m.test(text)) {
    return ok("[codex] hooks feature flag enabled");
  }
  return bad("[codex] hooks are DISABLED by default and the flag is missing — add `[features]` with `hooks = true` to " + p + " (re-running `npx @truverifai/init` adds it when safe)");
}

function codexDeliveryRow(ok, bad, warn) {
  // Definitive when the plugin dir exists on disk; otherwise best-effort via
  // the codex CLI, and NEVER green on uncertainty.
  // Codex's install convention (verified empirically 2026-07-31 from a real
  // `codex plugin add`): ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>
  const cache = path.join(os.homedir(), ".codex", "plugins", "cache");
  try {
    for (const mkt of fs.readdirSync(cache)) {
      const d = path.join(cache, mkt);
      try {
        if (fs.readdirSync(d).some((n) => n.includes("panel-review"))) {
          return ok("[codex] plugin installed (gate delivery): " + path.join(d, "panel-review"));
        }
      } catch (e) {
        /* not a dir */
      }
    }
  } catch (e) {
    /* cache absent */
  }
  const dirs = [
    path.join(os.homedir(), ".codex", "plugins"),
    path.join(os.homedir(), ".codex", "extensions"),
  ];
  for (const d of dirs) {
    try {
      if (fs.readdirSync(d).some((n) => n.includes("panel-review"))) {
        return ok("[codex] plugin installed (gate delivery): " + d);
      }
    } catch (e) {
      /* dir absent */
    }
  }
  try {
    const out = String(execSync("codex plugin list", { stdio: "pipe", timeout: 30000 }));
    if (!out.includes("panel-review")) {
      return bad("[codex] plugin NOT installed — run: codex plugin add panel-review@truverifai");
    }
    return warn("[codex] `codex plugin list` mentions panel-review but the install dir wasn't found — confirm a gate actually fires in codex before trusting it");
  } catch (e) {
    return warn("[codex] plugin install state UNVERIFIED (no plugin dir found; `codex plugin list` failed) — run: codex plugin add panel-review@truverifai");
  }
}

function cursorDeliveryRow(ok, bad) {
  const p = path.join(os.homedir(), ".cursor", "hooks.json");
  try {
    const text = fs.readFileSync(p, "utf8");
    if (text.includes(MARKER)) {
      return ok("[cursor] user-level hooks present (gate delivery, IDE + CLI): " + p);
    }
    return bad("[cursor] " + p + " exists but has no TruVerifAI entry — re-run npx @truverifai/init");
  } catch (e) {
    return bad("[cursor] no user-level hooks (" + p + ") — the Cursor gates are not armed; re-run npx @truverifai/init");
  }
}

/** TOOLS-half status of one platform's user-level MCP config: does the file
 *  exist, does it hold our server, and does its embedded key match the current
 *  one (a mismatch = key was rotated; re-run tvai init)? Never prints the key. */
function toolsStatus(file, mustContain, key) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, detail: "tools NOT connected (no " + file + ") — re-run tvai init" };
  }
  if (!text.includes(mustContain)) {
    return { ok: false, detail: "tools NOT connected (" + file + " has no TruVerifAI server) — re-run tvai init" };
  }
  if (key && !text.includes(key)) {
    return { ok: false, detail: "tools config STALE (key in " + file + " differs from the current key) — re-run tvai init" };
  }
  return { ok: true, detail: "tools connected: " + file };
}

/** One authenticated probe of the MCP endpoint itself — distinguishes
 *  key-rejected from unreachable. Any HTTP response = reachable. */
async function mcpReach(key) {
  try {
    const r = await api.requestJson("POST", mcpconf.mcpUrl(), {
      jsonrpc: "2.0", id: 0, method: "ping",
    }, {
      Authorization: "Bearer " + key,
      Accept: "application/json, text/event-stream",
    });
    if (r.status === 401 || r.status === 403) {
      return { ok: false, detail: "MCP endpoint REJECTED the key (HTTP " + r.status + ")" };
    }
    return { ok: true, detail: "MCP endpoint reachable (" + mcpconf.mcpUrl() + ", HTTP " + r.status + ")" };
  } catch (e) {
    return { ok: false, detail: "MCP endpoint UNREACHABLE: " + String(e.message).slice(0, 60) };
  }
}

async function run(argv) {
  const platforms = argvPlatforms(argv);
  const base = config.baseUrl();
  const key = config.apiKey();
  const rows = [];
  const ok = (s) => "  ✓ " + s;
  const bad = (s) => "  ✗ " + s;
  const warn = (s) => "  ! " + s;

  rows.push((await api.healthCheck(base)) ? ok("backend reachable: " + base) : bad("backend UNREACHABLE: " + base));

  let keyValid = false;
  if (!key) {
    rows.push(bad("no API key found (env TVAI_API_KEY / " + config.FILE + ") — run tvai login"));
  } else {
    const kc = await api.keyCheck(base, key).catch(() => ({ valid: false, status: 0 }));
    keyValid = kc.valid;
    rows.push(kc.valid ? ok("key valid (source: " + keySource() + ")") : bad("key INVALID (HTTP " + kc.status + ", source: " + keySource() + ") — run `npx @truverifai/init login` for a fresh key, then re-run `npx @truverifai/init` so every config picks it up"));
  }

  rows.push(pyExe() ? ok("python resolved: " + pyExe()) : bad("no working python (py/python/python3) — gates cannot run"));

  // node is as load-bearing as python now: every host's hook command is
  // `node <launcher> <host> <gate>`, so a missing node is a silently dead gate
  // on every platform (X2, 2026-08-14).
  const nodev = nodeExe();
  rows.push(nodev
    ? ok("node resolved: " + nodev + " (hook commands run `node run_gate.js …`)")
    : bad("node is NOT on PATH — every hook command launches the gate through "
        + "node, so the gates cannot run at all. Install Node 18+."));

  // Gate state (X8) — placed BEFORE the per-platform fires, because "is the
  // switch even on?" governs whether anything below it means anything.
  gateStateRows(ok, warn).forEach((r) => rows.push(r));

  // Option B update check (best-effort, fail-silent): compare this package's
  // version against the npm registry so a stale install is a doctor row too,
  // not only an in-gate nudge. Strict semver validation before rendering.
  try {
    const { execSync } = require("child_process");
    const latest = execSync("npm view @truverifai/init version", {
      stdio: "pipe", timeout: 8000,
    }).toString().trim();
    const installed = require("../package.json").version;
    const SEMVER = /^\d{1,4}\.\d{1,5}\.\d{1,5}$/;
    if (SEMVER.test(latest) && SEMVER.test(installed)) {
      const tup = (v) => v.split(".").map(Number);
      const [a, b] = [tup(installed), tup(latest)];
      const stale = a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
      rows.push(stale
        ? warn("update available: v" + latest + " (installed v" + installed +
               ") — run `npx @truverifai/init@latest` to refresh the gates")
        : ok("up to date (v" + installed + ")"));
    }
  } catch (e) {
    /* offline / npm missing — silence, never a doctor failure */
  }

  // Key-file permissions. On Windows, POSIX modes are a no-op — the real
  // protection is the NTFS ACL on the user profile dir (owner-only by
  // default). Say so honestly instead of implying 0600 (audit F-004).
  if (process.platform === "win32" && key) {
    rows.push(warn("Windows: key-bearing config files rely on your user-profile ACL "
      + "(no POSIX 0600). Fine on a single-user machine; on a shared one, check "
      + "folder permissions on your home directory."));
  }
  if (process.platform !== "win32" && fs.existsSync(config.FILE)) {
    try {
      const mode = fs.statSync(config.FILE).mode & 0o077;
      rows.push(
        mode === 0
          ? ok("config file permissions are owner-only (0600)")
          : bad(config.FILE + " is group/world-readable — run: chmod 600 " + config.FILE)
      );
    } catch (e) {
      /* stat raced; skip */
    }
  }

  const det = detect(process.cwd());
  if (!key) {
    // Without a key every synthetic fire fails open (the gate can't reach the
    // coverage endpoint), which would print a misleading "allowed" per platform.
    // Say the real reason once instead of N confusing lines.
    rows.push(warn("per-platform gate checks SKIPPED — set a key first "
      + "(`tvai login`, or `$env:TVAI_API_KEY = \"tvai_...\"`), then re-run."));
  } else if (!keyValid) {
    // Same fail-open cascade with an INVALID key (e.g. a dev key against prod,
    // found in owner testing 2026-07-31): every fire would print a misleading
    // per-platform "allowed". One actionable line instead.
    rows.push(warn("per-platform gate checks SKIPPED — the key is invalid, so "
      + "every gate fails open by design. Fix the key first (see the key row "
      + "above), then re-run."));
  } else {
    for (const p of platforms) {
      const fire = syntheticFire(p, key);
      rows.push((fire.armed ? ok : bad)("[" + p + "] " + fire.detail));
    }
    // The LAUNCHER path (X2): the rows above spawn the gate's python directly
    // and therefore prove only that the gate CODE is healthy. This one runs the
    // command form a host's hook config actually uses — the layer X1 broke on
    // macOS/Linux while every row above stayed green. Scoped to the VENDORED
    // launcher (audit F-001): Claude Code loads its own copy from the plugin
    // cache, which claudeInstalledHookRow() checks separately.
    const lf = launcherFire("codex", key);
    rows.push((lf.armed ? ok : bad)("[launcher/vendored] " + lf.detail));
    // ...and the OTHER launcher copy: the one inside Claude Code's plugin
    // cache that ${CLAUDE_PLUGIN_ROOT} resolves to. Separate artifact, separate
    // proof — this is the row that actually exercises Claude Code's delivery
    // path end to end, rather than inspecting it. Always emits a row: an
    // "unprobed" warn is visible, whereas silence would read as a pass.
    if (det.claude) {
      const cl = claudeLauncherFire(key);
      rows.push((cl.armed ? ok : (cl.warn ? warn : bad))("[launcher/claude] " + cl.detail));
    }
    // Nested-repo resolution drift alarm (deliberation mcp_45f1a19b; the
    // 2026-08-05 Codex incident class): fire the REAL commit gate with a
    // workdir-arg payload and a cd-chain payload against a temp parent/child
    // repo pair, and assert — via TVAI_PAYLOAD_LOG — that the resolver
    // inspected the CHILD. The day a host payload shape drifts past the
    // resolver, this row goes ✗ instead of the gates silently fail-opening.
    const nested = nestedRepoCheck(key);
    rows.push((nested.ok ? ok : bad)("[gates] " + nested.detail));
  }

  // GATE DELIVERY per plugin host (the layer between "gate code fires" and
  // "tools connected"): is the hook-carrying plugin/config actually installed?
  const gitRow = gitPrecommitRow(ok, bad, warn, det.git_root || process.cwd());
  if (gitRow) rows.push(gitRow);

  if (det.claude) claudeDeliveryRows(ok, bad, warn).forEach((r) => rows.push(r));
  if (det.claude) {
    // The installed bundle's own hook commands (X2 item 3) — the check that
    // would have caught X1 the day it shipped.
    const hookRow = claudeInstalledHookRow(ok, bad, warn);
    if (hookRow) rows.push(hookRow);
  }
  if (det.codex) {
    // User-level hooks are the PROVEN delivery path (plugin-bundled hooks
    // never get a trust prompt and untrusted hooks silently don't run).
    const uh = path.join(require("os").homedir(), ".codex", "hooks.json");
    try {
      const text = fs.readFileSync(uh, "utf8");
      rows.push(text.includes(MARKER)
        ? ok("[codex] user-level hooks present (gate delivery; needs one-time trust in codex): " + uh)
        : bad("[codex] " + uh + " exists but has no TruVerifAI entry — re-run npx @truverifai/init"));
    } catch (e) {
      rows.push(bad("[codex] no user-level hooks (" + uh + ") — the codex gates are not armed; re-run npx @truverifai/init"));
    }
    rows.push(codexDeliveryRow(ok, bad, warn));
    const ff = codexFeatureFlagRow(ok, bad);
    if (ff) rows.push(ff);
  }
  if (det.cursor) rows.push(cursorDeliveryRow(ok, bad));

  // TOOLS half (init v2): is the MCP review-tools config in place per platform,
  // with the CURRENT key? A gate can be armed while the tools it routes to are
  // missing — that split is exactly what this section makes visible.
  if (key) {
    const os2 = require("os");
    const HOME = os2.homedir();
    const toolSpots = [];
    if (det.claude) toolSpots.push(["claude", path.join(HOME, ".claude", ".credentials.json"), "panel-review@truverifai"]);
    if (det.codex) toolSpots.push(["codex", path.join(HOME, ".codex", "config.toml"), "mcp_servers." + mcpconf.SERVER]);
    if (det.copilot) toolSpots.push(["copilot", path.join(HOME, ".copilot", "mcp-config.json"), mcpconf.SERVER]);
    if (det.cursor) toolSpots.push(["cursor", path.join(HOME, ".cursor", "mcp.json"), mcpconf.SERVER]);
    if (det.gemini) toolSpots.push(["gemini", path.join(HOME, ".gemini", "settings.json"), mcpconf.SERVER + "-direct"]);
    if (det.vscode) {
      for (const dir of mcpconf.vscodeUserDirs()) {
        toolSpots.push(["vscode", path.join(dir, "mcp.json"), mcpconf.SERVER]);
      }
    }
    for (const [label, file, needle] of toolSpots) {
      const ts = toolsStatus(file, needle, key);
      rows.push((ts.ok ? ok : bad)("[" + label + "] " + ts.detail));
    }
    const reach = await mcpReach(key);
    rows.push((reach.ok ? ok : bad)(reach.detail));
  }

  // Which hook configs exist where (informational).
  const spots = [
    [".github/hooks/truverifai-gate.json", "copilot (repo)"],
    [".cursor/hooks.json", "cursor CLI (repo)"],
    [".gemini/settings.json", "gemini (repo)"],
  ];
  for (const [rel, label] of spots) {
    // Repo ROOT, not cwd — these are where the installers wrote them, and
    // checking cwd made every repo-level row vanish from a subdirectory (X11c).
    const p = path.join(det.git_root || process.cwd(), rel);
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, "utf8");
      if (text.includes("__GATES__")) {
        // Audit mcp_6510d831 F-003: a leftover template placeholder means the
        // hook command can never resolve — a SILENT fail-open. Loud, not warn.
        rows.push(bad(label + " config still contains the __GATES__ template placeholder — the gate can never fire. Re-run `tvai init` (or replace it with " + config.GATES_DIR + "): " + rel));
      } else {
        const marked = text.includes(MARKER);
        rows.push(marked ? ok(label + " hook config present: " + rel) : warn(label + " config exists but has no TruVerifAI entry: " + rel));
      }
    }
  }
  // F-004: in-plugin hook firing (VS Code/Cursor plugin ${...ROOT} vars) cannot
  // be verified from outside the host — say so rather than imply coverage.
  if (platforms.includes("vscode") || platforms.includes("cursor")) {
    rows.push(warn("in-plugin hook firing (VS Code/Cursor marketplace plugins) can't be verified externally — the synthetic fire above proves the GATE CODE; confirm in-host by making a risky edit once. The repo-level configs written by `tvai init` are verified here."));
  }
  if (!det.in_git_repo) rows.push(warn("not inside a git repo — repo-level hook configs not checked"));

  console.log("tvai doctor\n" + rows.join("\n"));
  const failed = rows.some((r) => r.startsWith("  ✗"));
  return failed ? 1 : 0;
}

function argvPlatforms(argv) {
  const i = argv.indexOf("--platform");
  if (i >= 0 && argv[i + 1]) return argv[i + 1].split(",");
  // Default: prove the core with the claude adapter (always vendored) plus the
  // config-file hosts this machine plausibly uses.
  return ["claude_code", "copilot_cli", "cursor_cli", "gemini"];
}

module.exports = {
  run, syntheticFire, pyExe, gateStateRows,
  // X2: the launcher-path probe and its parts, exported so the bundle tests can
  // assert doctor actually exercises the layer hooks.json uses.
  launcherFire, claudeLauncherFire, fireThroughLauncher,
  nodeExe, claudeInstalledHookRow, activeClaudeBundle, gitPrecommitRow,
  hookProblems,
  // readGateResult is the ONLY oracle for "armed". Exported so its strictness
  // is directly testable: every launcher exits 0 even when it silently does
  // nothing, so a deny must be proven by well-formed JSON on stdout and by
  // nothing else (audit mcp_5877e029 F-003).
  readGateResult,
};
