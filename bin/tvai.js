#!/usr/bin/env node
// tvai — TruVerifAI setup CLI (implementation plan §3.2).
//
//   tvai            = tvai init
//   tvai init       detect agents -> login (device flow) -> install gate code
//                   + per-host gate configs -> connect the MCP review tools
//                   (user-level configs, literal key) -> offer proactive rules
//                   (prompt, default yes) -> doctor
//   tvai login      device-flow login only (writes ~/.truverifai/config.json)
//   tvai doctor     verify: connectivity, key, python, SYNTHETIC GATE FIRE,
//                   tools-half config per platform
//   tvai gates      off | on | status — the ONE switch every gate delivery
//                   honors (the Claude /plugin toggle governs Claude Code's
//                   own hooks only, not the git hook or any other host)
//   tvai rules      add/refresh the proactive rules blocks in this repo's
//                   agent files ([check|remove|status])
//   tvai floors     THIS repo's custom floor classes (.truverifai/risk.json):
//                   status | check [--preview] | init | prompt
//   tvai logout     remove the stored key
//
// Zero dependencies (Node built-ins only) so `npx @truverifai/init` is the
// whole install. Identity is established in the BROWSER (device flow) — this
// process never sees a password and never asks for a pasted key.
"use strict";

const os = require("os");
const readline = require("readline");
const { spawn } = require("child_process");

const api = require("../lib/api");
const config = require("../lib/config");
const { detect } = require("../lib/detect");
const hosts = require("../lib/hosts");
const mcpconf = require("../lib/mcpconf");
const rules = require("../lib/rules");
const gates = require("../lib/gates");
const floors = require("../lib/floors");
const doctor = require("../lib/doctor");

function openBrowser(url) {
  try {
    const cmd =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true });
    // X5 (2026-08-14): spawn reports a missing executable via an ASYNCHRONOUS
    // 'error' event, not a synchronous throw — the try/catch above cannot catch
    // it, and an unhandled 'error' on a ChildProcess is an uncaught exception
    // that kills the process. `xdg-open` is routinely absent on headless Linux,
    // containers, devcontainers and bare WSL images, so `tvai login` printed the
    // device code and then died before deviceWait() could finish: login was
    // unfinishable on exactly the machines most likely to be automated.
    // Opening a browser is best-effort — the URL is already on screen.
    child.on("error", () => {});
    child.unref();
  } catch (e) {
    /* printing the URL is the fallback */
  }
}

async function login(platformsList) {
  const base = config.baseUrl();
  const label = os.hostname().slice(0, 60);
  const start = await api.deviceStart(base, label, platformsList || []);
  const approveUrl =
    "https://truverif.ai/device?code=" + encodeURIComponent(start.user_code);
  console.log("");
  console.log("  Open  " + approveUrl);
  console.log("  and confirm this code matches:  " + start.user_code);
  console.log("  (approve in a browser where you're signed in to truverif.ai)");
  console.log("");
  openBrowser(approveUrl);
  process.stdout.write("  Waiting for approval");
  const res = await api.deviceWait(base, start.device_code, start.interval, () =>
    process.stdout.write(".")
  );
  console.log("");
  if (res.status !== "complete") {
    console.error("  Login " + res.status + ". Run `tvai login` to retry.");
    return null;
  }
  config.write({ api_key: res.api_key });
  console.log("  ✓ Signed in — key '" + res.name + "' stored in " + config.FILE);
  return res.api_key;
}

async function init(argv) {
  const cwd = process.cwd();
  const det = detect(cwd);
  const found = ["claude", "codex", "copilot", "vscode", "cursor", "gemini"].filter(
    (k) => det[k]
  );
  console.log("Detected agents: " + (found.join(", ") || "none"));

  let key = config.apiKey();
  if (!key) {
    key = await login(found);
    if (!key) return 1;
  } else {
    console.log("  ✓ existing key found (" + (process.env.TVAI_API_KEY ? "env" : config.FILE) + ")");
  }

  // Gate code -> ~/.truverifai/gates/current (needed by config-file hosts).
  const gate = hosts.installGateCode();
  gate.notes.forEach((n) => console.log("  " + (gate.installed ? "✓ " : "! ") + n));

  // Resolve the interpreter ONCE, here, and record it (roadmap 1.1 / 1.4).
  // Hooks must never search in their own process — on Windows that search can
  // kill them outright, below JavaScript, uncatchably. This is the one place
  // the search is allowed to run, because a human is watching it.
  //
  // A failure here is `✗`, not `!`: without an interpreter there are no gates
  // at all, on any host. Finishing with a cheerful success message over a dead
  // install is exactly the false green this whole round exists to end.
  const py = gate.installed ? hosts.recordInterpreter()
                            : { installed: false, notes: ["skipped — gate code was not installed"] };
  py.notes.forEach((n) => console.log("  " + (py.installed ? "✓ " : "✗ ") + n));

  // Prove the gates can actually REACH us, here, at second five (roadmap 1b.3).
  // The MCP tools verify a different endpoint; a failure on the gate endpoint is
  // fail-open by design and therefore invisible until a gate silently lets
  // something through. This is the check that would have caught the macOS TLS
  // outage before any test row ran.
  const sc = hosts.runSelfCheck(py.python, key);
  sc.notes.forEach((n) => console.log("  " + (sc.installed ? "✓ " : "✗ ") + n));

  // Every repo-scoped write goes to the repo ROOT, not to wherever the user
  // happens to be standing (X11c). `cwd` stays the right base only for things
  // that are genuinely cwd-relative — there are none left here.
  const repoRoot = det.git_root || cwd;

  const results = [];
  if (det.claude) results.push(["Claude Code", hosts.installClaude()]);
  if (det.codex) results.push(["Codex CLI", hosts.installCodex()]);
  if (det.codex) results.push(["Codex hooks", hosts.installCodexHooks()]);
  if (det.copilot || det.vscode)
    results.push(["Copilot (repo)", det.in_git_repo ? hosts.installCopilot(repoRoot, "repo") : hosts.installCopilot(repoRoot, "user")]);
  if (det.cursor) results.push(["Cursor", hosts.installCursor(repoRoot)]);
  if (det.gemini && det.in_git_repo) results.push(["Gemini CLI", hosts.installGemini(repoRoot)]);
  if (det.antigravity && det.in_git_repo)
    results.push(["Antigravity", hosts.installAntigravity(repoRoot)]);

  // The git pre-commit gate, installed by default in a git repo (X11).
  //
  // It used to be opt-in behind `tvai hook`, which meant the one layer that
  // catches a `git commit` typed OUTSIDE any agent — and the only layer that is
  // bypass-resistant — shipped switched off, with nothing saying so. There was
  // never a recorded decision to make it opt-in; "fallback layer" (a statement
  // about its ROLE) had quietly become default-off. Safe to install: it refuses
  // to overwrite a pre-commit hook it did not write.
  //
  // It is also the ONLY repo-scoped thing here, so the note below has to say
  // which repo got it — otherwise running init once reads as "every repo is
  // covered".
  let gitGate = null;
  if (det.in_git_repo) {
    gitGate = hosts.installGitPrecommit(repoRoot);
    results.push(["git pre-commit gate", gitGate]);
  }

  for (const [name, r] of results) {
    console.log((r.installed ? "  ✓ " : "  ! ") + name);
    r.notes.forEach((n) => console.log("      " + n));
  }
  // X11d: only claim a repo-scoped install when one actually happened. When the
  // installer DECLINES (the user already has their own pre-commit hook) its own
  // notes carry the path and the manual line, and appending "this one is for
  // THIS repo only" underneath asserted an install that never took place — the
  // same false-reassurance this line was added to prevent.
  if (gitGate && gitGate.installed) {
    console.log("      ^ this one is for THIS repo only (" + repoRoot + ").");
    console.log("        Add it to another: cd <repo> && npx @truverifai/init hook");
  } else if (!det.in_git_repo) {
    console.log("  ! git pre-commit gate — skipped, not a git repo");
    console.log("      It catches commits made outside any agent. Add it with:");
    console.log("        cd <your repo> && npx @truverifai/init hook");
  }

  // MCP TOOLS half (init v2): connect the review tools the gate messages route
  // to. Without these, a gate block on the config-file hosts points the agent
  // at tools it doesn't have. User-level files only; literal key (env-var
  // header interpolation is unreliable across hosts).
  console.log("");
  console.log("Connecting the review tools (MCP):");
  const tools = [];
  if (det.claude) tools.push(["Claude Code", mcpconf.writeClaudeCreds(key)]);
  if (det.claude) tools.push(["Claude auto-mode allowlist", mcpconf.writeClaudePermissionAllow()]);
  if (det.claude) tools.push(["Claude marketplace auto-update", mcpconf.writeClaudeMarketplaceAutoUpdate()]);
  if (det.codex) tools.push(["Codex CLI", mcpconf.writeCodex(key)]);
  if (det.copilot) tools.push(["Copilot CLI", mcpconf.writeCopilot(key)]);
  if (det.vscode) tools.push(["VS Code", mcpconf.writeVSCode(key)]);
  if (det.cursor) tools.push(["Cursor", mcpconf.writeCursor(key)]);
  if (det.gemini) tools.push(["Gemini CLI", mcpconf.writeGemini(key)]);
  // Antigravity gets gates above, so it MUST get tools here (roadmap 3.2) —
  // a platform we gate without wiring its exits leaves a blocked agent with
  // a deny message whose every documented way forward is missing. T13 (the
  // gates-vs-tools parity test) fails if this pairing is ever broken again.
  if (det.antigravity) tools.push(["Antigravity", mcpconf.writeAntigravity(key)]);
  for (const [name, r] of tools) {
    // Three grades, not two (roadmap 2.2): `severity: "error"` marks a result
    // that leaves the tools UNUSABLE — on the Mac round that state printed as
    // `!`, read as informational, and shipped every Mac user without review
    // tools. A ✗ with a true cause and a working instruction, never a ! with a
    // remedy that cannot work.
    const mark = r.installed ? "  ✓ " : r.severity === "error" ? "  ✗ " : "  ! ";
    console.log(mark + name);
    r.notes.forEach((n) => console.log("      " + n));
  }

  // Proactive rules (init v2): interactive, defaults to yes; CI skips.
  const ruleNotes = await rules.initStep(det, repoRoot, argv);
  console.log("");
  ruleNotes.forEach((n) => console.log(n));

  console.log("");
  return doctor.run(argv);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith("-")) || "init";
  try {
    if (cmd === "init") process.exitCode = await init(argv);
    else if (cmd === "login") process.exitCode = (await login([])) ? 0 : 1;
    else if (cmd === "doctor") process.exitCode = await doctor.run(argv);
    else if (cmd === "hook") {
      // tvai hook install — the universal git pre-commit fallback (phase 3).
      // The wrapper invokes the gate code at ~/.truverifai/gates/current, so
      // install that FIRST — otherwise the wrapper points at a missing file,
      // the gate never runs, and the pre-commit gate is silently dead (the
      // owner's 2026-07-29 step-1.4 finding). Idempotent; safe to re-run.
      const g = hosts.installGateCode();
      g.notes.forEach((n) => console.log((g.installed ? "  ✓ " : "  ! ") + n));
      const r = hosts.installGitPrecommit(process.cwd());
      r.notes.forEach((n) => console.log((r.installed ? "  ✓ " : "  ! ") + n));
      process.exitCode = g.installed && r.installed ? 0 : 1;
    } else if (cmd === "gates") {
      // tvai gates [off|on|status] — the ONE switch every delivery honors (X9).
      // The Claude /plugin toggle governs Claude Code's own hooks and nothing
      // else, so it cannot turn off the git pre-commit hook or any other host.
      process.exitCode = await gates.run(argv);
    } else if (cmd === "rules") {
      // tvai rules [check|remove|status] — manage the proactive-rules blocks
      // in this repo's agent files (default: interactive add/update).
      process.exitCode = await rules.run(argv);
    } else if (cmd === "floors") {
      // tvai floors [status|check|init|prompt] [--preview] — customer-defined
      // custom floor classes for THIS repo (.truverifai/risk.json). Validation
      // runs through the vendored gate code so the CLI and the gates can never
      // disagree about what a valid floor is.
      process.exitCode = await floors.run(argv);
    } else if (cmd === "uninstall") {
      // X9b: the removal `logout` never was. logout clears the key and the MCP
      // entries, so the gates fail open for want of a token — it LOOKS
      // uninstalled while every hook is still wired in, and one `tvai login`
      // silently re-arms all of it. This takes the hooks out too.
      // removeHooks resolves the repo root itself, so this works from a
      // subdirectory too (X11c). Say so when they differ (audit F-006): this
      // command DELETES files, and doing that several levels above where the
      // user is standing without naming the target is its own small surprise.
      const unRoot = require("../lib/detect").gitRepoRoot(process.cwd());
      if (unRoot && unRoot !== process.cwd()) {
        console.log("Repo-scoped configs are removed from the enclosing repo root: " + unRoot);
      }
      console.log("Removing TruVerifAI hook configs:");
      hosts.removeHooks(process.cwd()).forEach((n) => console.log("  " + n));
      console.log("");
      console.log("Removing the MCP review-tool configs:");
      const gone = mcpconf.removeAll();
      (gone.length ? gone : ["nothing to remove"]).forEach((n) => console.log("  " + n));
      config.write({ api_key: "" });
      console.log("");
      console.log("  key cleared from " + config.FILE);
      console.log("  Revoke it at https://truverif.ai/settings/api-keys");
      console.log("  Marketplace plugins are owned by their host — remove those with");
      console.log("  `claude plugin uninstall panel-review@truverifai` (and the codex");
      console.log("  equivalent) if you installed them.");
      console.log("");
      console.log("  Prefer to keep everything installed but stop the blocking?");
      console.log("  `tvai gates off` does that instead.");
    } else if (cmd === "logout") {
      config.write({ api_key: "" });
      // Also strip the literal key from every platform MCP config init wrote
      // (audit mcp_e78430be F-001 — offboarding must not strand secrets).
      const removed = mcpconf.removeAll();
      removed.forEach((n) => console.log("  " + n));
      console.log("Key removed from " + config.FILE + ". Revoke it at https://truverif.ai/settings/api-keys");
    } else {
      console.log("usage: tvai [init|login|doctor|gates|rules|floors|logout|uninstall]");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error("tvai: " + (e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

main();
