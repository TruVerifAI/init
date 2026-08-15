// Proactive-rules injection — writes the "call the review tools before
// consequential decisions" text into the repo's agent rules files, inside
// marker-delimited managed blocks (synthesize mcp_64b5cd5e + owner decisions:
// interactive prompt DEFAULTS TO YES; non-interactive/CI skips unless --rules;
// TVAI_NO_RULES=1 force-skips; never touch global/user-level rules files).
//
// The text is the vendored rules/RULES.md (single source of truth, generated
// from plugin-core/rules/RULES.md). Blocks carry the CLI version so re-runs
// refresh in place and `tvai rules check` can report staleness. Files with
// TruVerifAI text OUTSIDE our markers are skipped, never rewritten.
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const VERSION = require("../package.json").version;

const START_RE = /<!-- TRUVERIFAI_RULES_START v([0-9][^ ]*) -->/;
const END = "<!-- TRUVERIFAI_RULES_END -->";

function startMarker() {
  return "<!-- TRUVERIFAI_RULES_START v" + VERSION + " -->";
}

function rulesText() {
  const p = path.join(__dirname, "..", "vendor", "rules", "RULES.md");
  return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").trim();
}

function block() {
  return startMarker() + "\n" + rulesText() + "\n" + END;
}

/** Repo-level rules-file target per detected platform. Cursor needs .mdc with
 *  alwaysApply frontmatter (a plain .md in .cursor/rules/ is silently ignored);
 *  that file is entirely ours, created whole. */
function targets(det, cwd) {
  const t = [];
  const seen = new Set();
  const add = (file, platform, whole) => {
    if (seen.has(file)) return;
    seen.add(file);
    t.push({ file: path.join(cwd, file), rel: file, platform, whole: !!whole });
  };
  if (det.claude) add("CLAUDE.md", "Claude Code");
  if (det.codex) add("AGENTS.md", "Codex");
  if (det.cursor) add(path.join(".cursor", "rules", "truverifai.mdc"), "Cursor", true);
  if (det.copilot || det.vscode) add(path.join(".github", "copilot-instructions.md"), "Copilot / VS Code");
  if (det.gemini) add("GEMINI.md", "Gemini");
  if (det.antigravity) add(path.join(".agents", "rules", "truverifai.md"), "Antigravity", true);
  return t;
}

function readFileOr(p, fallback) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    return fallback;
  }
}

/** Status of one target file: absent | current | stale | unmanaged. */
function fileStatus(file) {
  const text = readFileOr(file, null);
  if (text === null) return { state: "absent" };
  const m = text.match(START_RE);
  if (m) return { state: m[1] === VERSION ? "current" : "stale", version: m[1] };
  if (text.includes("TruVerifAI") || text.includes("truverifai")) {
    return { state: "unmanaged" }; // hand-pasted rules — never rewrite those
  }
  return { state: "no-block" };
}

/** Write/refresh the managed block in one file. Returns a result note. */
function writeOne(t) {
  const status = fileStatus(t.file);
  if (status.state === "unmanaged") {
    return "  ! " + t.rel + ": has TruVerifAI text outside our markers — left as-is (remove it and re-run to manage)";
  }
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  if (status.state === "absent") {
    const head = t.whole && t.rel.endsWith(".mdc") ? "---\nalwaysApply: true\n---\n\n" : "";
    fs.writeFileSync(t.file, head + block() + "\n", "utf8");
    return "  + " + t.rel + ": created (" + t.platform + ")";
  }
  const text = readFileOr(t.file, "");
  const m = text.match(START_RE);
  if (m) {
    const start = text.indexOf(m[0]);
    const end = text.indexOf(END);
    if (end > start) {
      const updated = text.slice(0, start) + block() + text.slice(end + END.length);
      fs.writeFileSync(t.file, updated, "utf8");
      return "  ~ " + t.rel + ": refreshed to v" + VERSION + (status.version !== VERSION ? " (was v" + status.version + ")" : "");
    }
  }
  // no-block: append below existing content.
  fs.writeFileSync(t.file, text.replace(/\n*$/, "\n\n") + block() + "\n", "utf8");
  return "  + " + t.rel + ": rules appended (" + t.platform + ")";
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });
}

/** The init-time step. Flags: --rules force-yes, --no-rules skip.
 *  Non-interactive (no TTY) skips unless --rules. TVAI_NO_RULES=1 always skips. */
async function initStep(det, cwd, argv) {
  if (process.env.TVAI_NO_RULES === "1" || argv.includes("--no-rules")) {
    return ["  rules: skipped (" + (argv.includes("--no-rules") ? "--no-rules" : "TVAI_NO_RULES=1") + ")"];
  }
  const t = targets(det, cwd);
  if (!t.length) return ["  rules: no agent platforms detected — nothing to write"];
  if (!det.in_git_repo) {
    return ["  rules: not a git repo — run `tvai rules` inside your project to add the proactive rules"];
  }
  const forced = argv.includes("--rules");
  if (!forced && !process.stdin.isTTY) {
    return ["  rules: non-interactive session — skipped (pass --rules to add them)"];
  }

  const updates = t.filter((x) => fileStatus(x.file).state !== "absent");
  const creates = t.filter((x) => fileStatus(x.file).state === "absent");
  if (!forced) {
    console.log("");
    console.log("  TruVerifAI can add its usage rules to this repo's agent files, so your");
    console.log("  agents call the review tools proactively on design/architecture decisions");
    console.log("  (the gates only fire on writes and commits). Affects collaborators once");
    console.log("  committed.");
    if (updates.length) console.log("    will update: " + updates.map((x) => x.rel).join(", "));
    if (creates.length) console.log("    will create: " + creates.map((x) => x.rel).join(", "));
    const ans = await ask("  Add the rules? [Y/n]: ");
    if (ans === "n" || ans === "no") return ["  rules: skipped by choice (run `tvai rules` anytime)"];
  }
  return t.map(writeOne);
}

/** `tvai rules [check|remove|status]` — default: interactive add/update. */
async function run(argv) {
  const { detect } = require("./detect");
  const det = detect(process.cwd());
  // Rules files belong at the repo ROOT — that is where agents look for
  // AGENTS.md / CLAUDE.md, and where `init` writes them. Running `tvai rules`
  // from a subdirectory used to report "not a git repo" (X11c); now it resolves
  // the root, and check/remove inspect the same files init created.
  const cwd = det.git_root || process.cwd();
  const sub = argv.filter((a) => !a.startsWith("-"))[1]; // after "rules"
  const t = targets(det, cwd);
  // `remove` deletes/strips files, and `check`/add report on files that may sit
  // several levels above where the user is standing. Name the target when it is
  // not the current directory (audit F-006).
  if (cwd !== process.cwd()) {
    console.log("  (repo root: " + cwd + ")");
  }

  if (sub === "check" || sub === "status") {
    let stale = false;
    for (const x of t) {
      const s = fileStatus(x.file);
      const tag = { absent: "absent", current: "current v" + VERSION, stale: "STALE v" + (s.version || "?") + " (current v" + VERSION + ")", unmanaged: "unmanaged TruVerifAI text", "no-block": "no rules block" }[s.state];
      console.log("  " + x.rel + ": " + tag);
      if (s.state === "stale") stale = true;
    }
    return stale ? 1 : 0;
  }
  if (sub === "remove") {
    for (const x of t) {
      const text = readFileOr(x.file, null);
      if (text === null) continue;
      const m = text.match(START_RE);
      const end = text.indexOf(END);
      if (m && end >= 0) {
        const start = text.indexOf(m[0]);
        const stripped = (text.slice(0, start) + text.slice(end + END.length)).replace(/\n{3,}/g, "\n\n").trim();
        if (stripped === "" || (x.whole && stripped === "---\nalwaysApply: true\n---")) {
          fs.unlinkSync(x.file); // file was entirely ours
          console.log("  - " + x.rel + ": removed (was fully managed)");
        } else {
          fs.writeFileSync(x.file, stripped + "\n", "utf8");
          console.log("  - " + x.rel + ": managed block removed");
        }
      }
    }
    return 0;
  }
  // default: add/update, honoring the same consent flow as init.
  const notes = await initStep(det, cwd, argv.includes("--rules") ? argv : argv.concat("--rules"));
  notes.forEach((n) => console.log(n));
  return 0;
}

module.exports = { initStep, run, targets, fileStatus, VERSION };
