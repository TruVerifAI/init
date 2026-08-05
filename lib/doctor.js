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

function pyExe() {
  for (const c of ["py", "python", "python3"]) {
    const r = spawnSync(c, ["-c", ""], { stdio: "pipe" });
    if (r.status === 0) return c;
  }
  return null;
}

/** Run the REAL write gate with a synthetic risky Edit and assert it denies.
 *  Entirely local except the coverage POST (which uses the caller's key and
 *  sends only the probe's own hunk hashes). Returns {armed, detail}. */
function syntheticFire(platform, apiKeyVal) {
  const py = pyExe();
  if (!py) return { armed: false, detail: "no working python found" };
  const gate = gatesPath("deliberate_gate.py");
  if (!fs.existsSync(gate)) {
    return { armed: false, detail: "gate code not installed (run tvai init)" };
  }
  const payload = JSON.stringify({
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(process.cwd(), "auth_check.py"),
      old_string: "if not user.has_permission(resource):\n    raise Forbidden()",
      new_string: "# permission check removed\npass",
    },
    cwd: process.cwd(),
    session_id: "tvai-doctor",
  });
  const r = spawnSync(py, [gate], {
    input: payload,
    encoding: "utf8",
    timeout: 60000,
    env: Object.assign({}, process.env, {
      TVAI_PLATFORM: platform,
      TVAI_API_KEY: apiKeyVal || "",
    }),
  });
  if (r.status !== 0) {
    return { armed: false, detail: "gate exited " + r.status + " (must be 0)" };
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
    if (d === "deny" || d === "block") {
      return { armed: true, detail: "synthetic risky edit was DENIED (gate armed)" };
    }
    return { armed: false, detail: "gate allowed the synthetic risky edit (decision=" + d + ")" };
  } catch (e) {
    return { armed: false, detail: "no deny JSON on stdout (allowed): " + out.slice(0, 80) };
  }
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
    const opts = ((s.pluginConfigs || {})["panel-review@truverifai"] || {}).options || {};
    if (opts.enable_gates === false) {
      // Installed and enabled can still be gate-dead: the plugin option
      // enable_gates=false makes every gate allow. Absent = default (true).
      rows.push(bad("[claude] plugin option enable_gates=false — every gate ALLOWS. /plugin -> panel-review -> Configure -> enable_gates=true, then /reload-plugins"));
    }
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
  if (det.claude) claudeDeliveryRows(ok, bad, warn).forEach((r) => rows.push(r));
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
    const p = path.join(process.cwd(), rel);
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

module.exports = { run, syntheticFire, pyExe };
