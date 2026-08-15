// `tvai gates off|on|status` — the ONE host-independent switch for the review
// gates (X9, docs/MCP/Cross OS bugs/GATE-DISABLE-GAPS-2026-08-15.md).
//
// WHY THIS EXISTS. The gates resolve `enable_gates` through three levels, in
// order, first non-empty wins:
//
//   1. TVAI_ENABLE_GATES env var        — host-independent
//   2. host.native_option(...)          — host-SPECIFIC
//   3. ~/.truverifai/config.json        — host-independent
//
// Level 2 is implemented by exactly ONE adapter (claude_code, reading
// CLAUDE_PLUGIN_OPTION_*), so the /plugin toggle reaches only the hooks Claude
// Code itself spawns. The git pre-commit hook is spawned by git; Cursor, Codex,
// Copilot, VS Code, Gemini and Antigravity hooks are spawned by those hosts.
// None of them see that env var, so none of them honor that toggle (X8).
//
// This command writes level 3, which every delivery reads — so it is the only
// switch that actually means "off everywhere".
//
// It writes the FILE, not the env var, because a CLI cannot durably set an
// environment variable for other processes. That ordering matters and `status`
// reports it: an exported TVAI_ENABLE_GATES still overrides what we write, and
// silently losing to it would reinvent X8 one level up.
//
// NOT AGENT-FACING. This is a human's switch. It is deliberately absent from
// RULES.md, the skills, and every gate deny message, which continue to tell the
// agent never to disable the gates — an agent that can turn off its own review
// has no review.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("./config");

const ENV_VAR = "TVAI_ENABLE_GATES";
const CLAUDE_PLUGIN_ID = "panel-review@truverifai";

/** Parse a value the way gate_lib does: enabled unless it is exactly "false".
 *  gate_lib computes `(_opt("enable_gates") or "true") == "true"`, and coerces a
 *  JSON boolean to the string "true"/"false" first — so a real boolean in
 *  config.json and the string "false" behave identically. Returns true/false,
 *  or null when unset (so callers can distinguish "set to on" from "not set"). */
function parseFlag(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim();
  if (!s) return null;
  return s === "true";
}

/** The Claude Code plugin toggle, read from the file Claude Code stores it in.
 *  Host-scoped: this governs Claude Code's own hooks and nothing else. */
function claudePluginFlag() {
  try {
    const p = path.join(os.homedir(), ".claude", "settings.json");
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    const opts = ((d.pluginConfigs || {})[CLAUDE_PLUGIN_ID] || {}).options || {};
    return parseFlag(opts.enable_gates);
  } catch (e) {
    return null; // no Claude Code, or unreadable — not our problem to report here
  }
}

/** Full resolution state. Never throws. */
function state() {
  const env = parseFlag(process.env[ENV_VAR]);
  const file = parseFlag(config.read().enable_gates);
  const claude = claudePluginFlag();

  // What a host-independent delivery (git pre-commit, and every non-Claude
  // host) actually gets: env, else file, else the shipped default of ON.
  let universal, universalSource;
  if (env !== null) { universal = env; universalSource = ENV_VAR + " env var"; }
  else if (file !== null) { universal = file; universalSource = config.FILE; }
  else { universal = true; universalSource = "default (nothing set)"; }

  // Claude Code's own hooks: env, else the plugin toggle, else file, else default.
  let claudeHooks, claudeSource;
  if (env !== null) { claudeHooks = env; claudeSource = ENV_VAR + " env var"; }
  else if (claude !== null) { claudeHooks = claude; claudeSource = "Claude /plugin toggle"; }
  else if (file !== null) { claudeHooks = file; claudeSource = config.FILE; }
  else { claudeHooks = true; claudeSource = "default (nothing set)"; }

  return {
    env, file, claude,
    universal, universalSource,
    claudeHooks, claudeSource,
    // The X8 condition: the two disagree, so the user has turned something off
    // and something else is still enforcing.
    split: universal !== claudeHooks,
  };
}

/** Write the host-independent switch. Returns the new state. */
function set(enabled) {
  config.write({ enable_gates: !!enabled });
  return state();
}

function renderStatus(s) {
  const lines = [];
  const onoff = (b) => (b ? "ON" : "OFF");
  lines.push("gate state");
  lines.push("  every host except Claude Code (incl. the git pre-commit hook):  "
    + onoff(s.universal));
  lines.push("      source: " + s.universalSource);
  lines.push("  Claude Code's own hooks:                                        "
    + onoff(s.claudeHooks));
  lines.push("      source: " + s.claudeSource);
  lines.push("");
  lines.push("  levels, in the order the gates read them:");
  lines.push("    1. " + ENV_VAR + " env var      "
    + (s.env === null ? "not set" : String(s.env)));
  lines.push("    2. Claude /plugin toggle       "
    + (s.claude === null ? "not set" : String(s.claude))
    + "   (Claude Code hooks ONLY — it cannot reach other hosts)");
  lines.push("    3. " + config.FILE + "  "
    + (s.file === null ? "not set" : String(s.file)));
  if (s.env !== null) {
    lines.push("");
    lines.push("  NOTE: " + ENV_VAR + " is exported in this environment and WINS over"
      + " everything below it. `tvai gates on|off` writes level 3, so it will have"
      + " no effect here until you unset it.");
  }
  if (s.split) {
    lines.push("");
    lines.push("  NOTE: these disagree. " + (s.claudeHooks ? "Claude Code is enforcing"
      + " while other hosts are not." : "Claude Code is not enforcing, but the git"
      + " pre-commit hook and every other host still are."));
    lines.push("  `tvai gates off` turns off everything; the /plugin toggle only ever"
      + " governs Claude Code.");
  }
  return lines.join("\n");
}

/** `tvai gates [off|on|status]` — default: status. Never throws. */
function run(argv) {
  const sub = (argv.filter((a) => !a.startsWith("-"))[1] || "status").toLowerCase();
  if (sub !== "off" && sub !== "on" && sub !== "status") {
    console.log("usage: tvai gates [off|on|status]");
    return 2;
  }
  if (sub === "status") {
    console.log(renderStatus(state()));
    return 0; // a query, not a health check — never fails on OFF
  }
  let s;
  try {
    s = set(sub === "on");
  } catch (e) {
    console.error("  could not write " + config.FILE + ": "
      + String(e && e.message).slice(0, 120));
    return 1;
  }
  // HEADLINE THE EFFECTIVE STATE, NOT THE WRITE (audit mcp_d79462de F-001).
  //
  // The first draft printed an unconditional "gates OFF" and put the caveats
  // below it. But the file we just wrote is the LOWEST-precedence level: an
  // exported TVAI_ENABLE_GATES outranks it for every delivery, and the Claude
  // /plugin toggle outranks it for Claude Code's hooks. So "written" and "in
  // effect" are different claims, and a user who reads the first line and stops
  // would be told the gates are off while they are still blocking — X8 again
  // with better UI, which is the one outcome this command exists to prevent.
  //
  // So: state what was SAVED, then state what is EFFECTIVE, and only claim a
  // clean result when the two agree everywhere.
  const want = sub === "on";
  console.log("  saved: enable_gates=" + want + " -> " + config.FILE);
  console.log("");

  const overridden = [];
  if (s.env !== null && s.env !== want) {
    overridden.push("    ! " + ENV_VAR + "=" + String(s.env) + " is exported in this"
      + " environment and OUTRANKS the file for EVERY delivery. Unset it for this"
      + " change to take effect.");
  }
  // Only blame the plugin toggle when the toggle is genuinely the deciding
  // level. If the env var is overriding, IT is the cause and the line above
  // already says so — reporting an unset toggle as "set to null" would send the
  // user to fix the wrong thing.
  if (s.claude !== null && s.claude !== want) {
    overridden.push("    ! Claude Code's /plugin toggle is set to "
      + String(s.claude) + ", which outranks the file for its OWN hooks."
      + " Change it in Claude Code: /plugin -> panel-review -> Configure ->"
      + " enable_gates = " + String(want) + ", then /reload-plugins.");
  }

  if (!overridden.length) {
    console.log("  effective: gates " + (want ? "ON" : "OFF") + " everywhere.");
    if (!want) {
      console.log("  The git pre-commit hook, Codex, Cursor, Copilot, VS Code,");
      console.log("  Gemini, Antigravity and Claude Code all honor this.");
      console.log("  The MCP review tools stay connected — only the gating stops.");
    }
  } else {
    console.log("  effective: MIXED — the file alone did NOT achieve"
      + " \"gates " + (want ? "ON" : "OFF") + "\":");
    overridden.forEach((l) => console.log(l));
    console.log("");
    console.log("  Run `tvai gates status` after fixing the above to confirm.");
  }
  return 0;
}

module.exports = { run, state, set, renderStatus, parseFlag, ENV_VAR };
