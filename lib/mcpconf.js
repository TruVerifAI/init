// Per-platform MCP-server config writers — the TOOLS half of init v2.
//
// Why these exist (design deliberation mcp_8bb74aec, 2026-07-30): the gates
// route a blocked agent to the TruVerifAI MCP review tools (audit_coding etc.);
// on platforms where init only wrote gate hooks, those tools were never
// connected, leaving a block with no in-agent release path. Also, env-var
// interpolation in MCP HTTP headers is UNRELIABLE across hosts (Cursor sends
// the literal "${env:VAR}" for remote servers; Gemini header substitution is
// contested upstream), so these writers embed the LITERAL key in USER-LEVEL
// files only (home dir — never a repo-committable path), chmod 0600 best-effort.
//
// Every writer returns {installed: bool, notes: [..]} and NEVER throws — a
// failed platform must not abort the others (the installer posture).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("./config");

// Structural sandbox guard (audit mcp_e78430be F-003): a test harness once
// leaked a write into the REAL VS Code profile because APPDATA wasn't
// overridden. With TVAI_HOME_OVERRIDE set, EVERY path this module touches
// resolves under it — home and APPDATA both — so a harness cannot reach real
// user files by forgetting one env var.
function homeDir() {
  const o = (process.env.TVAI_HOME_OVERRIDE || "").trim();
  return o || os.homedir();
}

function appDataDir() {
  const o = (process.env.TVAI_HOME_OVERRIDE || "").trim();
  if (o) return path.join(o, "AppData", "Roaming");
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

const SERVER = "truverifai";

function mcpUrl() {
  return (
    (process.env.TVAI_MCP_URL || "").trim() ||
    (config.read().mcp_url || "").trim() ||
    "https://mcp.truverif.ai/mcp"
  ).replace(/\/+$/, "");
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

function writeJson600(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(p, 0o600);
  } catch (e) {
    /* windows: profile-dir ACL is the protection */
  }
}

/** Merge-preserving JSON write: read existing (or fall back to `empty`), let
 *  `mutate` set our entry, write back 0600. Returns the standard result. */
function mergeJson(file, empty, mutate, note) {
  try {
    const existing = fs.existsSync(file) ? readJson(file) : empty;
    if (existing === null) {
      return {
        installed: false,
        notes: [file + " exists but is not valid JSON — not touching it. Fix it, then re-run `tvai init`."],
      };
    }
    mutate(existing);
    writeJson600(file, existing);
    return { installed: true, notes: [note + " -> " + file] };
  } catch (e) {
    return { installed: false, notes: [file + ": " + String(e.message).slice(0, 120)] };
  }
}

// --- Copilot CLI: ~/.copilot/mcp-config.json (top key mcpServers) -----------

function writeCopilot(key) {
  const file = path.join(homeDir(), ".copilot", "mcp-config.json");
  return mergeJson(file, { mcpServers: {} }, (o) => {
    o.mcpServers = o.mcpServers || {};
    o.mcpServers[SERVER] = {
      type: "http",
      url: mcpUrl(),
      headers: { Authorization: "Bearer " + key },
    };
  }, "MCP tools (Copilot CLI)");
}

// --- VS Code: user-profile mcp.json (top key servers), Stable + Insiders ----

function vscodeUserDirs() {
  const dirs = [];
  const flavors = ["Code", "Code - Insiders"];
  for (const flavor of flavors) {
    let base;
    if (process.platform === "win32") {
      base = path.join(appDataDir(), flavor, "User");
    } else if (process.platform === "darwin") {
      base = path.join(homeDir(), "Library", "Application Support", flavor, "User");
    } else {
      base = path.join(homeDir(), ".config", flavor, "User");
    }
    // Only write into installs that exist — never create VS Code's own dirs.
    if (fs.existsSync(base)) dirs.push(base);
  }
  return dirs;
}

function writeVSCode(key) {
  const dirs = vscodeUserDirs();
  if (!dirs.length) {
    return { installed: false, notes: ["no VS Code user profile dir found — skipped"] };
  }
  const notes = [];
  let any = false;
  for (const dir of dirs) {
    const r = mergeJson(path.join(dir, "mcp.json"), { servers: {} }, (o) => {
      o.servers = o.servers || {};
      o.servers[SERVER] = {
        type: "http",
        url: mcpUrl(),
        headers: { Authorization: "Bearer " + key },
      };
    }, "MCP tools (VS Code)");
    any = any || r.installed;
    notes.push(...r.notes);
  }
  return { installed: any, notes };
}

// --- Cursor: ~/.cursor/mcp.json ---------------------------------------------
// Literal key on purpose: Cursor does NOT resolve ${env:VAR} in headers for
// remote HTTP servers (confirmed upstream bug) — interpolation would silently
// send the literal string and every tools call would 401.

function writeCursor(key) {
  const file = path.join(homeDir(), ".cursor", "mcp.json");
  return mergeJson(file, { mcpServers: {} }, (o) => {
    o.mcpServers = o.mcpServers || {};
    o.mcpServers[SERVER] = {
      url: mcpUrl(),
      headers: { Authorization: "Bearer " + key },
    };
  }, "MCP tools (Cursor)");
}

// --- Gemini: ~/.gemini/settings.json (mcpServers) ---------------------------
// Server named "truverifai-direct" so it can never collide with the marketplace
// extension's own "truverifai" server (collision behavior is undefined; agents
// find TOOLS by name regardless of the server key). Header substitution is
// contested upstream (#5282/#5828) — literal key.

function writeGemini(key) {
  const file = path.join(homeDir(), ".gemini", "settings.json");
  return mergeJson(file, {}, (o) => {
    o.mcpServers = o.mcpServers || {};
    o.mcpServers[SERVER + "-direct"] = {
      httpUrl: mcpUrl(),
      headers: { Authorization: "Bearer " + key },
    };
  }, "MCP tools (Gemini)");
}

// --- Antigravity: ~/.gemini/config/mcp_config.json (mcpServers) --------------
// Roadmap 3.2: we installed blocking GATES for Antigravity but never connected
// the review tools — so a blocked Antigravity user had a deny message whose
// every documented exit was a tool they did not have. The "accidental
// coverage" theory (Antigravity reading the Gemini writer's
// ~/.gemini/settings.json) was checked against Antigravity's own docs and is
// FALSE: its MCP config is ~/.gemini/config/mcp_config.json (global) or
// .agents/mcp_config.json (workspace). We write the GLOBAL file so the tools
// follow the user across workspaces, matching every other writer here.
//
// Field names verified against antigravity.google/docs/mcp (2026-08-17):
// remote servers use `serverUrl` — the docs say explicitly that `url` and
// `httpUrl` are NOT supported, so copying any of the writers above verbatim
// would have produced a silently dead entry.

function writeAntigravity(key) {
  const file = path.join(homeDir(), ".gemini", "config", "mcp_config.json");
  return mergeJson(file, { mcpServers: {} }, (o) => {
    o.mcpServers = o.mcpServers || {};
    o.mcpServers[SERVER] = {
      serverUrl: mcpUrl(),
      headers: { Authorization: "Bearer " + key },
    };
  }, "MCP tools (Antigravity)");
}

// --- Codex: ~/.codex/config.toml — marker-delimited block append ------------
// TOML is NOT parsed/re-serialized (arbitrary user content, zero-dep CLI):
// we own only the block between our markers and replace exactly that on
// re-run. `http_headers` is codex's first-class static-header field for
// streamable-HTTP MCP servers — no env interpolation involved.

const TOML_START = "# [TRUVERIFAI_START] managed by @truverifai/init - do not edit by hand";
const TOML_END = "# [TRUVERIFAI_END]";

// Codex config management is MARKERLESS and line-scoped (2026-07-31 incident:
// codex REWRITES config.toml and interleaved its own tables — sandbox, hook
// trust state, marketplace records — inside our old marker region; a marker
// strip then deleted codex-owned state and broke its MCP startup. Region
// ownership is impossible in a file another program rewrites; we own only the
// specific lines we write.)

function codexOurTableLines(key) {
  return [
    "[mcp_servers." + SERVER + "]",
    'url = "' + mcpUrl() + '"',
    'http_headers = { "Authorization" = "Bearer ' + key + '" }',
  ];
}

function writeCodex(key) {
  const dir = path.join(homeDir(), ".codex");
  if (!fs.existsSync(dir)) {
    return { installed: false, notes: ["~/.codex not found — skipped"] };
  }
  const file = path.join(dir, "config.toml");
  try {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      /* absent: we create it */
    }
    const notes = [];

    // Legacy migration: old installs bracketed a region with marker COMMENTS.
    // Remove ONLY those comment lines (proven safe — comments carry no config);
    // never touch the region between, which codex may have filled with its own
    // state.
    if (text.indexOf("TRUVERIFAI_START") >= 0 || text.indexOf("TRUVERIFAI_END") >= 0) {
      text = text
        .split("\n")
        .filter((l) => l.indexOf("TRUVERIFAI_START") < 0 && l.indexOf("TRUVERIFAI_END") < 0)
        .join("\n");
      notes.push("legacy markers removed (comment lines only)");
    }

    // Features flag: append-only, and only when no [features] table exists at
    // all (a duplicate table is a hard TOML parse error).
    const hasFlag = /(^\s*hooks\s*=\s*true)|codex_hooks\s*=\s*true/m.test(text);
    const hasFeatures = /^\s*\[features\]/m.test(text);
    if (!hasFlag && hasFeatures) {
      notes.push("ACTION NEEDED: add `hooks = true` under your existing [features] table in ~/.codex/config.toml — Codex hooks are OFF by default and the gates are silent without it");
    } else if (!hasFlag) {
      text = (text ? text.replace(/\n*$/, "\n\n") : "") + "[features]\nhooks = true\n";
    }

    // Our server table: append when absent; when present, refresh ONLY our
    // url/http_headers lines inside it, preserving any keys codex (or the
    // user) added under our table.
    const header = "[mcp_servers." + SERVER + "]";
    const idx = text.indexOf(header);
    if (idx < 0) {
      text = text.replace(/\n*$/, "\n\n") + codexOurTableLines(key).join("\n") + "\n";
    } else {
      const bodyStart = idx + header.length;
      const rest = text.slice(bodyStart);
      const next = rest.search(/^\s*\[/m);
      const bodyEnd = next < 0 ? text.length : bodyStart + next;
      const body = text.slice(bodyStart, bodyEnd);
      if (body.indexOf(key) < 0 || body.indexOf(mcpUrl()) < 0) {
        const kept = body
          .split("\n")
          .filter((l) => l.trim() && !/^\s*url\s*=/.test(l) && !/^\s*http_headers\s*=/.test(l) && !/^\s*bearer_token_env_var\s*=/.test(l));
        const fresh = codexOurTableLines(key).slice(1).concat(kept).join("\n");
        text = text.slice(0, idx) + header + "\n" + fresh + "\n" + text.slice(bodyEnd);
        notes.push("refreshed url/key in " + header);
      }
    }

    fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch (e) {
      /* windows */
    }
    return { installed: true, notes: ["MCP tools (Codex) -> " + file].concat(notes) };
  } catch (e) {
    return { installed: false, notes: [file + ": " + String(e.message).slice(0, 120)] };
  }
}

// --- Claude Code: ~/.claude/.credentials.json (pluginSecrets) ---------------
// Pre-populates exactly what the /plugin Configure UI would set, so the
// plugin's `Bearer ${user_config.api_token}` resolves without a manual paste.
// The file ALSO holds the user's Claude OAuth login — corruption would break
// Claude itself — so this follows the strict protocol from deliberation
// mcp_8bb74aec: parse-validate, shape-validate, backup, merge ONLY our leaf,
// post-validate, atomic write, restore + manual fallback on ANY anomaly.

const CLAUDE_PLUGIN_ID = "panel-review@truverifai";

/** Does the macOS Keychain hold Claude Code's credentials?
 *
 *  On macOS, Claude Code stores its credentials in the login Keychain, not in
 *  ~/.claude/.credentials.json — that file does not exist there and never will,
 *  while Claude Code is installed, logged in, and running. So "no file" proves
 *  NOTHING about whether Claude Code has been run on a Mac; this probe is what
 *  actually answers the question (roadmap 2.1; REPORT-MAC-m34-FINAL.md §6.4,
 *  where the false inference left every Mac install without review tools and a
 *  remedy — "re-run tvai init" — that could never work).
 *
 *  TRI-STATE, deliberately (audit mcp_c06b6c66 F-002): "found" | "absent" |
 *  "unavailable". A probe that TIMES OUT (the Keychain can block on a UI
 *  authorization dialog), hits a missing `security` binary, or errors, must
 *  never collapse into "absent" — that would reproduce the exact false
 *  diagnosis this fix exists to kill ("Claude Code has not been run", on a
 *  Keychain-backed Mac where the probe merely failed). Not knowing is an
 *  answer, and it gets its own message.
 *
 *  Metadata check ONLY: no `-w` flag (which would PRINT the secret), stdio
 *  fully discarded, fixed argv array with no shell — the service name is a
 *  literal and must never be parameterized. The timeout is the hang bound for
 *  the UI-dialog case: expiry kills the child and `init` moves on.
 *
 *  `runner` is injectable for tests (the classification logic is provable
 *  offline; the REAL subprocess path is a Mac-round checklist item). */
function macKeychainHasClaudeCreds(runner) {
  if (process.platform !== "darwin" && !runner) return "absent";
  try {
    const run = runner || ((cmd, args, opts) =>
      require("child_process").spawnSync(cmd, args, opts));
    const r = run(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials"],
      { stdio: "ignore", timeout: 10000 }
    );
    if (r.error) return "unavailable"; // ENOENT, ETIMEDOUT, anything spawn-level
    if (r.status === 0) return "found";
    // A clean non-zero exit is `security` itself ANSWERING "no such item"
    // (exit 44). That is a real "absent", not an outage.
    return "absent";
  } catch (e) {
    return "unavailable";
  }
}

function writeClaudeCreds(key, keychainProbe) {
  const file = path.join(homeDir(), ".claude", ".credentials.json");
  const manual = "manual path: /plugin -> panel-review -> Configure -> api_token, then /reload-plugins";
  if (!fs.existsSync(file)) {
    // Never CREATE this file — Claude Code owns its shape. But never infer
    // "Claude Code has not been run" from its absence either: on macOS the
    // credentials live in the Keychain and this file never exists. That
    // inference is the same mistake that reported a missing cert.pem as
    // "server down" — the code had enough information to be accurate and
    // guessed instead. Probe for the thing we actually depend on.
    const probe = keychainProbe || macKeychainHasClaudeCreds;
    const kc = probe();
    if (kc === "found") {
      // Claude Code IS here, Keychain-backed. We deliberately do NOT write
      // into the Keychain: it is Claude Code's own item, corrupting it would
      // break Claude Code's login, and which store the plugin's api_token is
      // actually read from on macOS is unverified (roadmap Problem 2 open
      // question — verify on a real Mac before automating). Until then: a ✗
      // with the TRUE cause and an instruction that works, instead of a !
      // with a remedy that cannot. (The item can also outlive a logout, so
      // the instruction notes the login requirement rather than asserting one.)
      return {
        installed: false,
        severity: "error",
        keychain: true,
        notes: [
          "Claude Code review tools NOT connected.",
          "Claude Code stores credentials in the macOS Keychain, so the api_token",
          "cannot be pre-populated automatically on this platform.",
          "Set it once:  /plugin -> panel-review -> Configure -> api_token",
          "Then:         /reload-plugins   (you may need to be signed in to Claude Code first)",
        ],
      };
    }
    if (kc === "unavailable") {
      // The probe could not answer. Say THAT — claiming "Claude Code has not
      // been run" here would be the same false diagnosis this fix removes,
      // reintroduced through the error path.
      return {
        installed: false,
        severity: "error",
        notes: [
          "~/.claude/.credentials.json not found, and the macOS Keychain check could not complete —",
          "cannot determine whether Claude Code is set up on this machine.",
          "If you use Claude Code here, set the token once: " + manual,
        ],
      };
    }
    return {
      installed: false,
      notes: ["~/.claude/.credentials.json not found and no Keychain entry — Claude Code has not been run (or not logged in) on this machine; " + manual],
    };
  }
  const backup = file + ".tvai-backup";
  try {
    const raw = fs.readFileSync(file, "utf8");
    let creds;
    try {
      creds = JSON.parse(raw);
    } catch (e) {
      return { installed: false, notes: ["~/.claude/.credentials.json is not valid JSON — not touching it; " + manual] };
    }
    if (typeof creds !== "object" || creds === null || Array.isArray(creds)) {
      return { installed: false, notes: ["~/.claude/.credentials.json has an unexpected shape — not touching it; " + manual] };
    }
    const hadOauth = Object.prototype.hasOwnProperty.call(creds, "claudeAiOauth");
    const priorTopKeys = Object.keys(creds).length;
    const priorSecretKeys = Object.keys(creds.pluginSecrets || {}).length;
    fs.copyFileSync(file, backup);
    try {
      fs.chmodSync(backup, 0o600);
    } catch (e) {
      /* windows */
    }
    creds.pluginSecrets = creds.pluginSecrets || {};
    creds.pluginSecrets[CLAUDE_PLUGIN_ID] = Object.assign(
      {},
      creds.pluginSecrets[CLAUDE_PLUGIN_ID],
      { api_token: key }
    );
    // Post-merge validation (audit mcp_e78430be F-002): nothing may be LOST —
    // oauth still present if it was, pluginSecrets still a plain object, and
    // no top-level or secret entry dropped (our merge can only add).
    const badShape =
      (hadOauth && !Object.prototype.hasOwnProperty.call(creds, "claudeAiOauth")) ||
      typeof creds.pluginSecrets !== "object" || Array.isArray(creds.pluginSecrets) ||
      Object.keys(creds).length < priorTopKeys ||
      Object.keys(creds.pluginSecrets).length < priorSecretKeys;
    if (badShape) {
      fs.copyFileSync(backup, file);
      return { installed: false, notes: ["post-merge validation failed — restored backup; " + manual] };
    }
    const tmp = file + ".tvai-tmp";
    fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch (e) {
      /* windows */
    }
    return {
      installed: true,
      notes: [
        "plugin api_token set (Claude Code) -> " + file + "  (backup: " + path.basename(backup) + ")",
        "run /reload-plugins in open Claude Code sessions",
      ],
    };
  } catch (e) {
    try {
      if (fs.existsSync(backup)) fs.copyFileSync(backup, file);
    } catch (e2) {
      /* best effort restore */
    }
    return { installed: false, notes: ["credentials write failed (" + String(e.message).slice(0, 80) + ") — restored backup; " + manual] };
  }
}

// Claude Code's auto-mode permission classifier (CC 2.1.221+, observed live
// 2026-08-04) is intent-shaped and denies MCP calls that look like
// "skip a safety review" — record_gate_skip's pre-review reasons and
// review_deferred_to_commit — while allowing the review tools themselves.
// An explicit permissions.allow rule for our server exempts the calls. The
// agent CANNOT self-add this (the classifier blocks settings edits — good);
// init runs as the user, outside the classifier, so it can.
//
// SECURITY BOUNDARY (audit mcp_f3a88b2b F-006): this rule exempts every
// current AND FUTURE tool on the panel-review server from the classifier,
// and old installs inherit that silently. The server must therefore stay
// review/telemetry-only — adding a file-write, shell-exec, or repo-mutating
// tool to it is a breaking security change that invalidates this rule.
const CLAUDE_MCP_ALLOW_RULE = "mcp__plugin_panel-review_truverifai";

/** Merge our MCP server into ~/.claude/settings.json permissions.allow so
 *  the auto-mode classifier permits record_gate_skip / defer calls.
 *  Same discipline as writeClaudeCreds: never create the file, backup,
 *  additive-only merge, post-merge nothing-lost validation, atomic rename. */
function writeClaudePermissionAllow() {
  const file = path.join(homeDir(), ".claude", "settings.json");
  const manual = "manual path: /permissions -> add allow rule " + CLAUDE_MCP_ALLOW_RULE;
  if (!fs.existsSync(file)) {
    // No settings.json = Claude Code not (fully) set up; never create a file
    // Claude Code owns.
    return { installed: false, notes: ["~/.claude/settings.json not found — run `claude` once to initialize it, then re-run npx @truverifai/init; " + manual] };
  }
  const backup = file + ".tvai-backup";
  try {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      return { installed: false, notes: ["~/.claude/settings.json is not valid JSON — not touching it. Fix the file, then re-run npx @truverifai/init; " + manual] };
    }
    if (typeof d !== "object" || d === null || Array.isArray(d)) {
      return { installed: false, notes: ["~/.claude/settings.json has an unexpected shape — not touching it; " + manual] };
    }
    const perms = d.permissions;
    if (perms !== undefined && (typeof perms !== "object" || perms === null || Array.isArray(perms))) {
      return { installed: false, notes: ["settings.json `permissions` has an unexpected shape — not touching it; " + manual] };
    }
    const allow = perms && perms.allow;
    if (allow !== undefined && !Array.isArray(allow)) {
      return { installed: false, notes: ["settings.json `permissions.allow` is not an array — not touching it; " + manual] };
    }
    if (Array.isArray(allow) && allow.indexOf(CLAUDE_MCP_ALLOW_RULE) !== -1) {
      return { installed: true, notes: ["auto-mode allowlist already present (" + CLAUDE_MCP_ALLOW_RULE + ")"] };
    }
    const priorTopKeys = Object.keys(d).length;
    const priorAllowLen = Array.isArray(allow) ? allow.length : 0;
    fs.copyFileSync(file, backup);
    d.permissions = d.permissions || {};
    d.permissions.allow = Array.isArray(d.permissions.allow) ? d.permissions.allow : [];
    d.permissions.allow.push(CLAUDE_MCP_ALLOW_RULE);
    // Post-merge: our merge can only ADD — nothing may be lost.
    const bad =
      Object.keys(d).length < priorTopKeys ||
      !Array.isArray(d.permissions.allow) ||
      d.permissions.allow.length !== priorAllowLen + 1 ||
      d.permissions.allow.indexOf(CLAUDE_MCP_ALLOW_RULE) === -1;
    if (bad) {
      fs.copyFileSync(backup, file);
      return { installed: false, notes: ["post-merge validation failed — restored backup; " + manual] };
    }
    const tmp = file + ".tvai-tmp";
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n", { encoding: "utf8" });
    fs.renameSync(tmp, file);
    return {
      installed: true,
      notes: [
        "auto-mode allowlist -> " + file + " permissions.allow (" + CLAUDE_MCP_ALLOW_RULE + ")",
        "lets Claude Code's auto-mode classifier permit record_gate_skip / defer calls; takes effect in NEW sessions",
      ],
    };
  } catch (e) {
    try {
      if (fs.existsSync(backup)) fs.copyFileSync(backup, file);
    } catch (e2) {
      /* best effort restore */
    }
    return { installed: false, notes: ["settings write failed (" + String(e.message).slice(0, 80) + ") — restored backup; " + manual] };
  }
}

// --- Removal (audit mcp_e78430be F-001): offboarding must not strand literal
// keys in six user-level files. Strips OUR entries only; used by `tvai logout`.
// (Rotation needs no special path: re-running `tvai init` rewrites every
// config with the current key.)

function removeAll() {
  const notes = [];
  const dropJson = (file, topKey, name) => {
    if (!fs.existsSync(file)) return;
    const o = readJson(file);
    if (!o || !o[topKey] || !(name in o[topKey])) return;
    delete o[topKey][name];
    writeJson600(file, o);
    notes.push("removed " + name + " from " + file);
  };
  dropJson(path.join(homeDir(), ".copilot", "mcp-config.json"), "mcpServers", SERVER);
  dropJson(path.join(homeDir(), ".cursor", "mcp.json"), "mcpServers", SERVER);
  dropJson(path.join(homeDir(), ".gemini", "settings.json"), "mcpServers", SERVER + "-direct");
  for (const dir of vscodeUserDirs()) {
    dropJson(path.join(dir, "mcp.json"), "servers", SERVER);
  }
  // Codex: MARKERLESS removal — delete only OUR server table section (header
  // to the next table header) plus any legacy marker comment lines. NEVER a
  // region strip: codex rewrites its config and interleaves its own state
  // (the 2026-07-31 incident deleted its sandbox/trust records that way).
  // The [features] hooks flag is left in place — harmless, and other hooks
  // may rely on it.
  const toml = path.join(homeDir(), ".codex", "config.toml");
  if (fs.existsSync(toml)) {
    try {
      let text = fs.readFileSync(toml, "utf8")
        .split("\n")
        .filter((l) => l.indexOf("TRUVERIFAI_START") < 0 && l.indexOf("TRUVERIFAI_END") < 0)
        .join("\n");
      const header = "[mcp_servers." + SERVER + "]";
      const idx = text.indexOf(header);
      if (idx >= 0) {
        const bodyStart = idx + header.length;
        const rest = text.slice(bodyStart);
        const next = rest.search(/^\s*\[/m);
        const end = next < 0 ? text.length : bodyStart + next;
        text = (text.slice(0, idx) + text.slice(end)).replace(/\n{3,}/g, "\n\n");
        fs.writeFileSync(toml, text, { encoding: "utf8", mode: 0o600 });
        notes.push("removed " + header + " from " + toml);
      }
    } catch (e) {
      notes.push(toml + ": " + String(e.message).slice(0, 80));
    }
  }
  // Claude credentials: same safeguarded protocol, deleting only our leaf.
  const credFile = path.join(homeDir(), ".claude", ".credentials.json");
  if (fs.existsSync(credFile)) {
    try {
      const creds = JSON.parse(fs.readFileSync(credFile, "utf8"));
      if (creds && typeof creds === "object" && !Array.isArray(creds) &&
          creds.pluginSecrets && CLAUDE_PLUGIN_ID in creds.pluginSecrets) {
        fs.copyFileSync(credFile, credFile + ".tvai-backup");
        delete creds.pluginSecrets[CLAUDE_PLUGIN_ID];
        const tmp = credFile + ".tvai-tmp";
        fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, credFile);
        notes.push("removed plugin api_token from " + credFile);
      }
    } catch (e) {
      notes.push(credFile + ": " + String(e.message).slice(0, 80));
    }
  }
  return notes;
}

module.exports = {
  mcpUrl,
  // Exported so other modules that touch user files (hosts.removeHooks) can
  // honor the SAME sandbox override instead of each rolling its own homedir
  // (Rule 8, and the reason the guard exists at all — audit mcp_e78430be F-003).
  homeDir,
  SERVER,
  writeCopilot,
  writeVSCode,
  writeCursor,
  writeGemini,
  writeAntigravity,
  writeCodex,
  writeClaudeCreds,
  macKeychainHasClaudeCreds,
  writeClaudePermissionAllow,
  CLAUDE_MCP_ALLOW_RULE,
  removeAll,
  vscodeUserDirs,
  TOML_START,
  TOML_END,
};
