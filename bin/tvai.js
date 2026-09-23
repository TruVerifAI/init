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
const { detect, gitAvailable } = require("../lib/detect");
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

// Fix B2 (2026-09-16, external-tester consent): the canonical agent
// short-names for --only / --skip / the plan prompt. Must match detect()'s
// keys and the per-host installers below.
const KNOWN_AGENTS = ["claude", "codex", "copilot", "vscode", "cursor", "gemini", "antigravity"];
const SKIP_COMPONENTS = ["hook", "rules"];
const FOOTPRINT_URL = "https://truverif.ai/settings/mcp";

function askLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(question, (ans) => {
      answered = true;
      rl.close();
      resolve(String(ans || "").trim().toLowerCase());
    });
    // Ctrl-D / closed stdin: the question callback never fires and the
    // promise used to hang until node exited SILENTLY mid-command
    // (adversarial review minor). Resolve null -> caller treats as decline.
    rl.on("close", () => {
      if (!answered) resolve(null);
    });
  });
}

/** Parse `--name a,b` or `--name=a,b` into a lowercase token list. */
function parseListFlag(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) return { error: name + " requires a comma-separated list (e.g. " + name + " claude,cursor)" };
      return { list: v.toLowerCase().split(/[\s,]+/).filter(Boolean) };
    }
    if (a.startsWith(name + "=")) {
      const list = a.slice(name.length + 1).toLowerCase().split(/[\s,]+/).filter(Boolean);
      // `--only=` (empty value) must get the same explicit error as the
      // space form, not fall through to a puzzling "No agents remain".
      if (!list.length) return { error: name + " requires a comma-separated list (e.g. " + name + "=claude,cursor)" };
      return { list };
    }
  }
  return { list: null };
}

/** Fix B2: resolve detected agents + flags into the install scope. Returns
 *  {error} on invalid/conflicting input — errors fire BEFORE the plan, so a
 *  bad flag never half-installs. */
function resolveInitScope(detected, argv) {
  const only = parseListFlag(argv, "--only");
  if (only.error) return { error: only.error };
  const skip = parseListFlag(argv, "--skip");
  if (skip.error) return { error: skip.error };
  const skipList = skip.list || [];

  if (only.list) {
    // Same component-aware split as parsePlanAnswer (backlog 13): `--only hook`
    // used to say "Unknown agent" about a token init itself documents.
    const comps = only.list.filter((t) => SKIP_COMPONENTS.indexOf(t) >= 0);
    const bad = only.list.filter((t) => KNOWN_AGENTS.indexOf(t) < 0 && SKIP_COMPONENTS.indexOf(t) < 0);
    if (comps.length || bad.length) {
      const problems = [];
      if (comps.length) {
        problems.push("`" + comps.join("`, `") + "` " + (comps.length === 1
          ? "is a component, not an agent — control it with --skip "
          : "are components, not agents — control them with --skip ") + comps.join(","));
      }
      if (bad.length) problems.push("Unknown agent(s) in --only: " + bad.join(", "));
      problems.push("Known agents: " + KNOWN_AGENTS.join(", "));
      return { error: problems.join("\n") };
    }
  }
  const badSkip = skipList.filter((t) => KNOWN_AGENTS.indexOf(t) < 0 && SKIP_COMPONENTS.indexOf(t) < 0);
  if (badSkip.length) {
    return { error: "Unknown token(s) in --skip: " + badSkip.join(", ") + "\nKnown agents: " + KNOWN_AGENTS.join(", ") + "\nComponents: " + SKIP_COMPONENTS.join(", ") };
  }
  if (argv.includes("--rules") && (skipList.includes("rules") || argv.includes("--no-rules"))) {
    return { error: "Conflicting flags: --rules cannot be combined with --no-rules / --skip rules." };
  }

  let agents = detected.slice();
  const notDetected = only.list ? only.list.filter((t) => detected.indexOf(t) < 0) : [];
  if (only.list) agents = agents.filter((a) => only.list.indexOf(a) >= 0);
  agents = agents.filter((a) => skipList.indexOf(a) < 0);

  return {
    agents,
    notDetected,
    includeHook: !skipList.includes("hook"),
    skipRules: skipList.includes("rules"),
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes"),
  };
}

/** Fix B2: parse the single plan-prompt answer. Returns one of
 *  {all} | {decline} | {agents} | {retry: "<message>"}. */
function parsePlanAnswer(ans, planned) {
  if (ans === "" || ans === "y" || ans === "yes") return { all: true };
  if (ans === "n" || ans === "no" || ans === "q" || ans === "quit") return { decline: true };
  const toks = ans.split(/[\s,]+/).filter(Boolean);
  // Separators-only (",,,") used to fall through as {agents: []} and proceed
  // into sign-in with NOTHING selected (adversarial review finding 5) —
  // an unreadable answer re-prompts like any other.
  if (!toks.length) {
    return { retry: "  Could not read that answer.\n  Available here: " + planned.join(", ") };
  }
  // Every problem in ONE corrective message (FW1 smoke finding 2: a mixed
  // bad answer like "claud, hook, xyz" got only the component note, so each
  // problem class cost the user a separate attempt out of their three).
  // Grammar follows the count — "`hook` is a component", not "are".
  const comps = toks.filter((t) => SKIP_COMPONENTS.indexOf(t) >= 0);
  const unknown = toks.filter((t) => SKIP_COMPONENTS.indexOf(t) < 0 && KNOWN_AGENTS.indexOf(t) < 0);
  const missing = toks.filter((t) => KNOWN_AGENTS.indexOf(t) >= 0 && planned.indexOf(t) < 0);
  const problems = [];
  if (comps.length) {
    problems.push("  `" + comps.join("`, `") + "` " + (comps.length === 1
      ? "is a component, not an agent — control it with --skip "
      : "are components, not agents — control them with --skip ") + comps.join(","));
  }
  if (unknown.length) problems.push("  Unknown agent(s): " + unknown.join(", "));
  if (missing.length) problems.push("  Not detected on this machine (or excluded by flags): " + missing.join(", "));
  if (problems.length) {
    problems.push("  Available here: " + planned.join(", "));
    return { retry: problems.join("\n") };
  }
  // Dedupe, keep the plan's order so output stays stable.
  const set = {};
  toks.forEach((t) => { set[t] = true; });
  return { agents: planned.filter((a) => set[a]) };
}

async function init(argv) {
  const cwd = process.cwd();
  const det = detect(cwd);
  const detected = KNOWN_AGENTS.filter((k) => det[k]);

  const scope = resolveInitScope(detected, argv);
  if (scope.error) {
    console.error(scope.error);
    return 2;
  }
  if (!scope.agents.length) {
    console.error(detected.length
      ? "No agents remain after applying --only/--skip. Nothing was changed."
      : "No supported agents detected on this machine. Nothing was changed.\nManual setup: " + FOOTPRINT_URL);
    return 2;
  }

  // Fix B2: the PLAN — printed after detection and before any sign-in or
  // write, so declining leaves zero footprint (no account, no key, no files).
  // INIT-GIT-PREFLIGHT: git's absence changes what the plan can promise —
  // check it up front, not mid-scroll.
  const gitOk = gitAvailable();
  const existingKey = config.apiKey();
  const repoRoot = det.git_root || cwd;
  const planHook = scope.includeHook && det.in_git_repo && gitOk;
  // Rules files follow the SELECTED agents, not everything detected.
  const detSel = Object.assign({}, det);
  KNOWN_AGENTS.forEach((k) => { if (scope.agents.indexOf(k) < 0) detSel[k] = false; });
  // TVAI_NO_RULES honored in the PLAN too — --yes must not "accept" a rules
  // line that initStep will silently skip (plan == execution).
  const planRules = !scope.skipRules && !argv.includes("--no-rules")
      && process.env.TVAI_NO_RULES !== "1" && det.in_git_repo
    ? rules.targets(detSel, repoRoot).map((x) => x.rel) : [];

  console.log("TruVerifAI setup plan" + (scope.dryRun ? "  [dry-run — nothing will be written]" : ""));
  console.log("  - " + (existingKey
    ? "reuse the existing API key (no sign-in needed)"
    : "sign you in through your browser (creates an API key on your account)"));
  console.log("  - review gates + review tools for " + scope.agents.length + " agent" +
    (scope.agents.length === 1 ? "" : "s") + ": " + scope.agents.join(", "));
  console.log("    (gate code in ~/.truverifai; entries in each agent's own config)");
  if (planHook) console.log("  - git pre-commit gate for this repo (" + repoRoot + ")");
  if (planRules.length) console.log("  - repo-level usage rules: " + planRules.join(", "));
  if (scope.notDetected.length) console.log("  (requested but not detected: " + scope.notDetected.join(", ") + ")");
  if (!gitOk) {
    // INIT-GIT-PREFLIGHT: loud, up front, before any consent — a no-git
    // machine used to half-install silently and read healthy.
    console.log("  ! git NOT FOUND (or not runnable) — needed by the Claude Code plugin");
    console.log("    (the marketplace is a git clone), the pre-commit gate, and the gates'");
    console.log("    diff engine. Install it (winget install Git.Git / git-scm.com), then");
    console.log("    re-run npx @truverifai/init. The other layers install now, DEGRADED.");
  }
  console.log("  Full footprint: " + FOOTPRINT_URL + "  ·  Undo: npx @truverifai/init uninstall");
  console.log("");

  if (scope.dryRun) {
    console.log("[dry-run] Nothing was written and no sign-in happened.");
    return 0;
  }

  // Fix B2: the ONE prompt. Enter/Y = everything above (rules included — the
  // separate rules prompt is folded into this consent); a typed agent list
  // narrows the install; n exits clean. Non-interactive keeps today's
  // contract (proceed; rules skipped unless --rules) but SAYS so.
  let promptedYes = false;
  if (scope.yes) {
    // --yes is EXPLICIT acceptance of the printed plan, rules line included —
    // unlike the bare non-interactive fallthrough below, which stays a
    // compatibility mode and keeps rules opt-in (--rules).
    console.log("--yes: proceeding with the plan above.");
    promptedYes = true;
  } else if (!process.stdin.isTTY) {
    console.log("Non-interactive session: proceeding without confirmation.");
    console.log("(Preview with --dry-run, or pass --yes to make acceptance explicit.)");
  } else {
    console.log("Customize: --only <agents> | --skip <agents,hook,rules> | --dry-run | --yes");
    let answered = null;
    for (let attempt = 0; attempt < 3 && !answered; attempt++) {
      const ans = await askLine("Proceed for " + (scope.agents.length === 1 ? "this agent" : "all " + scope.agents.length + " agents") +
        "? [Y/n, or type agent names to pick, e.g. claude,cursor]: ");
      if (ans === null) {
        // Ctrl-D / stdin closed mid-prompt: an explicit decline, not a hang.
        answered = { decline: true };
        break;
      }
      const p = parsePlanAnswer(ans, scope.agents);
      if (p.retry) { console.log(p.retry); continue; }
      answered = p;
    }
    if (!answered) {
      // Audit F-003: exhausted retries are broken input, not an intentional
      // decline — nonzero, still zero footprint (we are before any sign-in
      // or write by construction).
      console.log("Could not read a valid answer after 3 attempts. Nothing was installed.");
      console.log("Manual setup and docs: " + FOOTPRINT_URL);
      return 2;
    }
    if (answered.decline) {
      console.log("Nothing was installed and no sign-in happened.");
      console.log("Manual setup and docs: " + FOOTPRINT_URL);
      return 0;
    }
    if (answered.agents) {
      scope.agents = answered.agents;
      KNOWN_AGENTS.forEach((k) => { if (scope.agents.indexOf(k) < 0) detSel[k] = false; });
      console.log("Proceeding for: " + scope.agents.join(", "));
    }
    promptedYes = true;
  }

  let key = existingKey;
  if (!key) {
    // Fix B2 (deliberation fix 3): the device-flow payload carries the
    // SELECTED agents, not everything detected — declined agents are none of
    // our business.
    key = await login(scope.agents);
    if (!key) return 1;
  } else {
    console.log("  ✓ existing key found (" + (process.env.TVAI_API_KEY ? "env" : config.FILE) + ")");
  }
  const sel = {};
  scope.agents.forEach((a) => { sel[a] = true; });
  // Fix B2 (deliberation fix 4): a guarded step that fails hard must surface
  // in a closing summary with a NONZERO exit — never a silent success.
  const hardFails = [];

  // Gate code -> ~/.truverifai/gates/current (needed by config-file hosts).
  const gate = hosts.installGateCode();
  gate.notes.forEach((n) => console.log("  " + (gate.installed ? "✓ " : "! ") + n));
  if (!gate.installed) hardFails.push("gate code (~/.truverifai)");

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
  if (!py.installed) hardFails.push("Python interpreter (gates cannot run)");

  // Prove the gates can actually REACH us, here, at second five (roadmap 1b.3).
  // The MCP tools verify a different endpoint; a failure on the gate endpoint is
  // fail-open by design and therefore invisible until a gate silently lets
  // something through. This is the check that would have caught the macOS TLS
  // outage before any test row ran.
  const sc = hosts.runSelfCheck(py.python, key);
  sc.notes.forEach((n) => console.log("  " + (sc.installed ? "✓ " : "✗ ") + n));
  if (!sc.installed) hardFails.push("gate self-check (server unreachable from the gates)");

  // Fix B2: every per-host install below is keyed on the SELECTED agents
  // (sel), not on raw detection — the plan/prompt selection is the contract.
  const results = [];
  if (sel.claude) results.push(["Claude Code", hosts.installClaude(gitOk)]);
  if (sel.codex) results.push(["Codex CLI", hosts.installCodex()]);
  if (sel.codex) results.push(["Codex hooks", hosts.installCodexHooks()]);
  if (sel.copilot || sel.vscode)
    // Finding 4: pass the selection so only the chosen half's hook file lands
    // (gates↔tools pairing holds under --only/--skip and prompt subsets).
    results.push(["Copilot (repo)", hosts.installCopilot(
      repoRoot, det.in_git_repo ? "repo" : "user",
      { copilot: !!sel.copilot, vscode: !!sel.vscode })]);
  if (sel.cursor) results.push(["Cursor", hosts.installCursor(repoRoot)]);
  if (sel.gemini && det.in_git_repo) results.push(["Gemini CLI", hosts.installGemini(repoRoot)]);
  if (sel.antigravity && det.in_git_repo)
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
  if (det.in_git_repo && scope.includeHook && gitOk) {
    gitGate = hosts.installGitPrecommit(repoRoot);
    results.push(["git pre-commit gate", gitGate]);
  }

  for (const [name, r] of results) {
    console.log((r.installed ? "  ✓ " : "  ! ") + name);
    r.notes.forEach((n) => console.log("      " + n));
    if (!r.installed && r.severity === "error") hardFails.push(name);
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
  } else if (!scope.includeHook) {
    console.log("  ! git pre-commit gate — skipped (--skip hook)");
    console.log("      Add it later with: npx @truverifai/init hook");
  } else if (!gitOk) {
    console.log("  ! git pre-commit gate — skipped (git is not installed)");
    console.log("      Install git, then: npx @truverifai/init hook");
  }

  // MCP TOOLS half (init v2): connect the review tools the gate messages route
  // to. Without these, a gate block on the config-file hosts points the agent
  // at tools it doesn't have. User-level files only; literal key (env-var
  // header interpolation is unreliable across hosts).
  console.log("");
  console.log("Connecting the review tools (MCP):");
  const tools = [];
  if (sel.claude) tools.push(["Claude Code", mcpconf.writeClaudeCreds(key)]);
  if (sel.claude) tools.push(["Claude auto-mode allowlist", mcpconf.writeClaudePermissionAllow()]);
  if (sel.claude) tools.push(["Claude marketplace auto-update", mcpconf.writeClaudeMarketplaceAutoUpdate()]);
  if (sel.codex) tools.push(["Codex CLI", mcpconf.writeCodex(key)]);
  if (sel.copilot) tools.push(["Copilot CLI", mcpconf.writeCopilot(key)]);
  if (sel.vscode) tools.push(["VS Code", mcpconf.writeVSCode(key)]);
  if (sel.cursor) tools.push(["Cursor", mcpconf.writeCursor(key)]);
  if (sel.gemini) tools.push(["Gemini CLI", mcpconf.writeGemini(key)]);
  // Antigravity gets gates above, so it MUST get tools here (roadmap 3.2) —
  // a platform we gate without wiring its exits leaves a blocked agent with
  // a deny message whose every documented way forward is missing. T13 (the
  // gates-vs-tools parity test) fails if this pairing is ever broken again.
  if (sel.antigravity) tools.push(["Antigravity", mcpconf.writeAntigravity(key)]);
  for (const [name, r] of tools) {
    // Three grades, not two (roadmap 2.2): `severity: "error"` marks a result
    // that leaves the tools UNUSABLE — on the Mac round that state printed as
    // `!`, read as informational, and shipped every Mac user without review
    // tools. A ✗ with a true cause and a working instruction, never a ! with a
    // remedy that cannot work.
    const mark = r.installed ? "  ✓ " : r.severity === "error" ? "  ✗ " : "  ! ";
    console.log(mark + name);
    r.notes.forEach((n) => console.log("      " + n));
    if (!r.installed && r.severity === "error") hardFails.push(name + " (review tools)");
  }

  // Proactive rules (Fix B2): the separate rules prompt is FOLDED into the
  // plan confirmation — an interactive Y already covered the rules line the
  // plan printed, so initStep runs force-yes here. --skip rules / --no-rules
  // skip; non-interactive keeps today's contract (skip unless --rules).
  // Rules targets follow the SELECTED agents (detSel), not raw detection.
  let rulesArgv = argv;
  if (scope.skipRules) rulesArgv = argv.concat("--no-rules");
  else if (promptedYes && !argv.includes("--no-rules") && !argv.includes("--rules")) rulesArgv = argv.concat("--rules");
  const ruleNotes = await rules.initStep(detSel, repoRoot, rulesArgv);
  console.log("");
  ruleNotes.forEach((n) => console.log(n));

  console.log("");
  // Doctor must not be able to eat the closing manifest: a thrown network
  // error here used to abort init entirely, losing the INCOMPLETE summary —
  // exactly on the machines that most need it.
  let rc = 1;
  try {
    rc = await doctor.run(argv);
  } catch (e) {
    console.log("doctor could not complete (" + String(e && e.message || e).slice(0, 120) + ")");
    hardFails.push("doctor run failed — re-run npx @truverifai/init doctor once connectivity is back");
  }

  // Fix B2 (deliberation fixes 1+4): a legible ending — a one-line manifest
  // on success, and an explicit incomplete-summary + NONZERO exit when any
  // guarded step failed hard. Never a success line over a partial install.
  // INIT-GIT-PREFLIGHT: a no-git machine is DEGRADED by definition (the
  // Claude plugin cannot install; the gates cannot operate on diffs) — say
  // so per-platform, and never print the success manifest over it.
  if (!gitOk) {
    // Wording follows the SELECTION (adversarial review minor): don't claim
    // "Claude plugin NOT installed" on an --only run that never included it.
    hardFails.push("git missing — " + (sel.claude ? "Claude plugin NOT installed; " : "")
      + (scope.includeHook && det.in_git_repo === false ? "" : "pre-commit gate skipped; ")
      + "the gates cannot operate until git is installed");
  }
  const claudeRes = (results.find((r) => r[0] === "Claude Code") || [])[1];
  console.log("");
  if (claudeRes && claudeRes.staged) {
    console.log("claude: STAGED — marketplace registered; finish in the Claude Code app:");
    console.log("        + button -> Plugins -> install \"AI Panel Review\", then restart the app.");
  }
  if (hardFails.length) {
    console.log("Setup INCOMPLETE — " + hardFails.length + " step(s) failed:");
    hardFails.forEach((f) => console.log("  - " + f));
    console.log("Repair: re-run npx @truverifai/init@latest  ·  Undo: npx @truverifai/init uninstall");
    return rc || 1;
  }
  console.log("Done: " + scope.agents.length + " agent" + (scope.agents.length === 1 ? "" : "s") +
    " configured (" + scope.agents.join(", ") + ")" +
    (gitGate && gitGate.installed ? ", git pre-commit gate" : "") + ".");
  console.log("Full footprint: " + FOOTPRINT_URL + "  ·  Undo: npx @truverifai/init uninstall");
  return rc;
}

async function main() {
  const argv = process.argv.slice(2);
  // --version answers the question directly (standard CLI convention). Before
  // this existed, `npx @truverifai/init --version` fell through to the default
  // init command and performed a COMPLETE non-interactive install (FW2 report
  // finding 1 / backlog #20) — the opposite of what a version probe asked for.
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(require("../package.json").version);
    return;
  }
  // Fix B2: --only/--skip/--platform take a VALUE — the old `first token not
  // starting with "-"` rule would read `--only claude` as the command
  // "claude". Skip value-taking flags' arguments when finding the command.
  const VALUE_FLAGS = ["--only", "--skip", "--platform"];
  let cmd = "init";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.indexOf(a) >= 0) { i++; continue; }
    if (a.startsWith("-")) continue;
    cmd = a;
    break;
  }
  // Backlog #20, the consent half: an UNKNOWN flag must never start an
  // install. Flags are skipped when finding the command, so any unrecognized
  // flag used to fall through to the default init — which, in a non-TTY
  // session, proceeded without confirmation and wrote real config. On the
  // init path (default or explicit), reject unknown flags in ONE corrective
  // message and write nothing — the same strict posture --only already has.
  // Explicit subcommands keep owning their own flags (doctor takes
  // --platform, gates takes on/off, ...), so they are not validated here.
  if (cmd === "init") {
    const INIT_FLAGS = ["--only", "--skip", "--dry-run", "--yes", "--rules", "--no-rules"];
    const badFlags = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--only" || a === "--skip") { i++; continue; } // their values are validated by resolveInitScope
      if (a.startsWith("-") && INIT_FLAGS.indexOf(a) < 0 && badFlags.indexOf(a) < 0) badFlags.push(a);
    }
    if (badFlags.length) {
      console.error("Unknown flag" + (badFlags.length === 1 ? "" : "s") + ": " + badFlags.join(", "));
      console.error("init flags: --only <agents> · --skip <agents,hook,rules> · --dry-run · --yes · --rules · --no-rules");
      console.error("commands:   init · login · doctor · gates · rules · floors · logout · uninstall  (--version prints the version)");
      console.error("Nothing was installed or changed.");
      process.exitCode = 2;
      return;
    }
  }
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
      // Fix A8 audit F-002: partial-failure honesty. A guarded LOCAL cleanup
      // step that fails lands here, and uninstall then exits NONZERO with a
      // manual-attention summary — never a silent "success". (A NETWORK
      // failure on the best-effort revoke is the fail-open special case: it
      // warns but does not fail the exit, so an offline uninstall completes.)
      const attention = [];
      console.log("Removing the MCP review-tool configs:");
      const gone = mcpconf.removeAll();
      (gone.length ? gone : ["nothing to remove"]).forEach((n) => {
        console.log("  " + n);
        // Finding 1+2: a per-file removal failure is a manual-attention item
        // — a locked config used to abort the whole run or vanish silently.
        if (n.startsWith("ERROR ")) attention.push(n);
      });
      // Fix A8: the macOS Keychain copy of the plugin token used to survive
      // uninstall (the dashboard told users to clear it by hand). Guarded
      // read-modify-write of OUR leaf only — the Keychain item itself is
      // Claude Code's credential store and is never deleted.
      // TVAI_HOME_OVERRIDE guard (finding 5): the Keychain is MACHINE state
      // with no sandbox — a sandboxed test/run must never touch the real one.
      if (process.platform === "darwin" && process.env.TVAI_HOME_OVERRIDE) {
        // Audit F-005: say the skip out loud — a sandboxed run must not read
        // as having removed a credential it deliberately never touched.
        console.log("  Keychain cleanup SKIPPED (TVAI_HOME_OVERRIDE is set — sandbox mode)");
      }
      if (process.platform === "darwin" && !process.env.TVAI_HOME_OVERRIDE) {
        const kc = mcpconf.macKeychainRemovePluginToken();
        if (kc.state === "removed") {
          console.log("  plugin api_token removed from the macOS Keychain");
        } else if (kc.state !== "absent") {
          console.log("  Keychain plugin token NOT removed (" + (kc.why || kc.state) + ")");
          console.log("  clear it via /plugin -> AI Panel Review -> Configure");
          attention.push("macOS Keychain plugin token (/plugin -> AI Panel Review -> Configure)");
        }
      }
      // Fix A8: our two ~/.claude/settings.json entries (permissions.allow
      // rule + marketplace auto-update record) used to outlive uninstall —
      // consent should not outlive the thing consented to.
      mcpconf.removeClaudeSettingsEntries().forEach((n) => {
        console.log("  " + n);
        if (!n.startsWith("removed ")) attention.push("~/.claude/settings.json entries (" + n + ")");
      });
      console.log("");
      console.log("Removing the usage-rules blocks from this repo:");
      // Fix A8: leftover rules told agents to call tools that no longer
      // exist. Removes THIS repo's blocks; other repos are out of reach.
      await rules.run(["rules", "remove"]);
      console.log("  (ran `tvai rules` in other repos too? run `tvai rules remove` there)");
      console.log("");
      // Fix A8: revoke the key SERVER-SIDE before discarding it locally — a
      // "fully uninstalled" machine used to leave a live credential valid
      // until the user remembered the dashboard. Best-effort; the key is
      // read BEFORE ~/.truverifai is deleted below.
      // Finding 7: revoke the FILE-stored key — the one this install minted
      // and is about to delete — never the TVAI_API_KEY env var, which may
      // be a shared/CI credential this machine doesn't own.
      const unKey = (config.read().api_key || "").trim();
      const envKey = (process.env.TVAI_API_KEY || "").trim();
      if (envKey && envKey !== unKey) {
        console.log("  TVAI_API_KEY is set in your environment and differs from the stored key —");
        console.log("  it is NOT revoked or touched. Unset it, or revoke it on the dashboard.");
        attention.push("TVAI_API_KEY env var (left untouched — unset or revoke it yourself)");
      }
      let revoked = false;
      if (unKey) {
        const rr = await api.revokeSelf(config.baseUrl(), unKey);
        revoked = !!rr.ok;
        // 0.19.47: a 401 on a RE-RUN usually means the key is already dead,
        // but a 401 can also be a live key sent to the wrong base_url —
        // don't claim verified success, state both readings and where to
        // check (batch audit F-001: "already revoked - nothing to revoke"
        // masked the wrong-environment case).
        console.log(revoked
          ? "  API key revoked server-side"
          : rr.status === 401
            ? "  API key not accepted by the server (already revoked — expected on a "
              + "re-run — or not valid for this server). If you did not expect this, "
              + "check https://truverif.ai/settings/api-keys"
            : "  API key NOT revoked (" + (rr.why || ("HTTP " + rr.status)) +
              ") — revoke it at https://truverif.ai/settings/api-keys");
      }
      // Fix A8: remove ~/.truverifai entirely — after the key is revoked and
      // the gate code went with removeHooks, only inert state remains.
      // Basename guard: never rm a directory we didn't name.
      {
        const fs = require("fs");
        const path = require("path");
        if (path.basename(config.DIR) === ".truverifai" && fs.existsSync(config.DIR)) {
          fs.rmSync(config.DIR, { recursive: true, force: true });
          console.log("  removed " + config.DIR);
        }
      }
      // Fix A8: delete our .tvai-backup safety copies — the credentials one
      // is a stale copy of Claude OAuth secrets. Guarded: only deleted after
      // verifying the live file is healthy and free of our entries.
      mcpconf.removeTvaiBackups().forEach((n) => {
        console.log("  " + n);
        if (n.indexOf(": kept (") !== -1 || n.startsWith("ERROR ")) attention.push("backup file " + n);
      });
      if (attention.length) {
        console.log("");
        console.log("  Uninstall finished with " + attention.length + " item(s) needing manual attention:");
        attention.forEach((a) => console.log("    - " + a));
        process.exitCode = 1;
      }
      console.log("");
      // 0.19.47 Option B (owner ruling): try the host CLIs to remove the
      // plugins init installed — best-effort, each attempt printed; a
      // failure never fails the uninstall (the notes say what to do).
      // Belt-and-braces try/catch (batch audit F-002/F-003): every path
      // inside is already guarded, but an unforeseen throw here must not
      // swallow the survivors note below — that note is the user's only
      // record of what an uninstall cannot reach.
      try {
        hosts.uninstallHostPlugins().forEach((n) => console.log("  " + n));
      } catch (e) {
        console.log("  host plugin removal errored (" + String(e && e.message || e).slice(0, 120)
          + ") — remove marketplace plugins with the host's own command or UI");
      }
      console.log("");
      // 0.19.47 backlog 7b (FW1 R9): name the survivors instead of letting a
      // recreated 200-byte cache read as a failed delete. Git pre-commit
      // gates in OTHER repos are repo-scoped by design — this command cannot
      // reach them — and any plugin that survived the best-effort removal
      // above re-creates ~/.truverifai/python-path.json (a non-secret
      // interpreter cache) the next time its gate fires.
      console.log("  Still installed elsewhere (this command cannot reach them):");
      console.log("  - git pre-commit gates in OTHER repos — remove each with");
      console.log("    `cd <repo> && npx @truverifai/init uninstall` (they fail open,");
      console.log("    loudly, until then).");
      console.log("  - Any marketplace plugin the removal above could not reach (no");
      console.log("    runnable host CLI, or it reported a failure) — remove it with the");
      console.log("    host's own command or UI. While a plugin remains, its gates keep");
      console.log("    running fail-open and may recreate a small non-secret cache under");
      console.log("    ~/.truverifai (python-path.json).");
      console.log("  Codex users: `[features] hooks = true` in ~/.codex/config.toml is");
      console.log("  left in place (other hooks may rely on it) — delete that line");
      console.log("  yourself if nothing else uses hooks.");
      console.log("");
      console.log("  Prefer to keep everything installed but stop the blocking?");
      console.log("  `tvai gates off` does that instead.");
    } else if (cmd === "logout") {
      config.write({ api_key: "" });
      // Also strip the literal key from every platform MCP config init wrote
      // (audit mcp_e78430be F-001 — offboarding must not strand secrets).
      let logoutIssues = 0;
      const removed = mcpconf.removeAll();
      removed.forEach((n) => {
        console.log("  " + n);
        if (n.startsWith("ERROR ")) logoutIssues++;
      });
      // Fix A8: the macOS Keychain copy is a key too — same offboarding rule.
      // Finding 5: never touch the real Keychain under a sandbox override.
      if (process.platform === "darwin" && process.env.TVAI_HOME_OVERRIDE) {
        // Audit F-005: say the skip out loud — a sandboxed run must not read
        // as having removed a credential it deliberately never touched.
        console.log("  Keychain cleanup SKIPPED (TVAI_HOME_OVERRIDE is set — sandbox mode)");
      }
      if (process.platform === "darwin" && !process.env.TVAI_HOME_OVERRIDE) {
        const kc = mcpconf.macKeychainRemovePluginToken();
        if (kc.state === "removed") {
          console.log("  plugin api_token removed from the macOS Keychain");
        } else if (kc.state !== "absent") {
          // Finding: a failed Keychain strip was SILENT here, unlike uninstall.
          console.log("  Keychain plugin token NOT removed (" + (kc.why || kc.state) + ")");
          console.log("  clear it via /plugin -> AI Panel Review -> Configure");
          logoutIssues++;
        }
      }
      // Finding 3: removeAll's credentials strip mints a fresh .tvai-backup
      // CONTAINING the token it just removed — logout must clean it exactly
      // like uninstall does (offboarding must not strand secrets).
      mcpconf.removeTvaiBackups().forEach((n) => {
        console.log("  " + n);
        if (n.startsWith("ERROR ")) logoutIssues++;
      });
      console.log("Key removed from " + config.FILE + ". Revoke it at https://truverif.ai/settings/api-keys");
      if (logoutIssues) {
        console.log(logoutIssues + " item(s) above need manual attention.");
        process.exitCode = 1;
      }
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
