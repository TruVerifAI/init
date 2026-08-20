"use strict";
// tvai floors — customer-defined custom floor classes
// (docs/MCP/Custom floors/CUSTOM-FLOORS-DESIGN.md §6: the authoring workflow).
//
//   tvai floors             = status
//   tvai floors status      validate this repo's .truverifai/risk.json + list floors
//   tvai floors check       same, but exit 1 on any problem (the workflow's step-3
//                           validator); --preview pipes `git ls-files` through the
//                           ONE vendored Python validator for per-floor CONCRETE
//                           path coverage — never a second regex dialect (Rule 8)
//   tvai floors init        scaffold an INERT .truverifai/risk.json (empty list —
//                           a floor only exists when someone defines one) and print
//                           the agent prompt that drafts real floors
//   tvai floors prompt      print the agent prompt only
//
// The heavy lifting (schema validation, collision checks, caps, regex compilation,
// preview matching) lives in the vendored gate code (risk_classifier.py
// --check-floors) so the gates and this CLI can never disagree about what a valid
// floor is.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const config = require("./config");
const { gitRepoRoot } = require("./detect");

const RISK_REL = path.join(".truverifai", "risk.json");

const SCAFFOLD = {
  version: 1,
  custom_floors: [],
};

const SCHEMA_EXAMPLE = `  {
    "version": 1,
    "custom_floors": [
      {
        "name": "tax_rules",
        "description": "Tax calculation logic and rate tables — must be reviewed before release",
        "paths": ["(^|/)src/tax/"],
        "keywords": ["tax_rate", "withholding_calc"],
        "patterns": ["(?i)\\\\bTAX_YEAR_\\\\d{4}\\\\b"],
        "exclude_paths": ["(^|/)src/tax/examples/"]
      }
    ]
  }`;

const PROMPT = `  Ask your coding agent (copy-paste):

    Help me define TruVerifAI custom floor classes for this repo.
    1) Interview me briefly: which code here, if changed incorrectly, would be
       catastrophic for the business? (modules, config/data files, key identifiers)
    2) Scan the repo and draft .truverifai/risk.json — path-based floors for those
       modules, the 5-15 most load-bearing identifiers as keywords, and
       exclude_paths for examples/sandboxes/generated copies. Schema: each floor is
       {name, description (required — my words, shown when the gate blocks),
       paths/keywords/patterns (>=1), exclude_paths?, test_exempt? (default true)}.
    3) Run \`npx @truverifai/init floors check --preview\` and show me the file plus
       which real files each floor covers.
    4) Revise with me until I approve, then save and commit the file.

  Changes to code a floor covers will then always require a real review — the free
  judgment skip is denied, exactly like TruVerifAI's built-in floors (auth, secrets,
  money, migrations, removed guards).`;

// --------------------------------------------------------------------------
// plumbing
// --------------------------------------------------------------------------

function pythonCmd() {
  // The interpreter init resolved and recorded (~/.truverifai/python-path.json —
  // resolve_python.js owns that file). Fall back to a cheap probe so `floors`
  // still works on a machine that ran an older init.
  try {
    const rec = JSON.parse(
      fs.readFileSync(path.join(config.DIR, "python-path.json"), "utf8")
    );
    if (rec && rec.python) return rec.python;
  } catch (e) {
    /* probe below */
  }
  for (const cand of ["python3", "python"]) {
    const r = spawnSync(cand, ["--version"], { stdio: "ignore", timeout: 15000 });
    if (r.status === 0) return cand;
  }
  return null;
}

function classifierPath() {
  const p = path.join(config.GATES_DIR, "risk_classifier.py");
  return fs.existsSync(p) ? p : null;
}

function lsFiles(root) {
  const r = spawnSync("git", ["-C", root, "ls-files"], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? String(r.stdout || "") : "";
}

/** Run the vendored validator. Returns {report} or {error}. */
function runCheck(root, preview) {
  const py = pythonCmd();
  if (!py)
    return { error: "no usable Python found — run `npx @truverifai/init` first" };
  const clf = classifierPath();
  if (!clf)
    return {
      error:
        "gate code not installed (" + config.GATES_DIR + ") — run `npx @truverifai/init`",
    };
  const args = [clf, "--check-floors", root];
  if (preview) args.push("--preview");
  const r = spawnSync(py, args, {
    encoding: "utf8",
    timeout: 60000,
    input: preview ? lsFiles(root) : "",
  });
  try {
    return { report: JSON.parse(String(r.stdout || "").trim()) };
  } catch (e) {
    // Name the failure precisely (C3 audit F-003/F-004): a generic "failed" on a
    // customer-facing command is a support ticket.
    const cause =
      r.error && r.error.code === "ETIMEDOUT"
        ? "validator timed out after 60s"
        : r.error && r.error.code === "ENOBUFS"
          ? "validator output exceeded the buffer"
          : r.error && r.error.code
            ? "could not run " + py + " (" + r.error.code + ")"
            : "validator did not return a report";
    return {
      error:
        cause +
        " [" + py + " " + clf + "]" +
        (r.stderr ? " — " + String(r.stderr).trim().slice(0, 300) : ""),
    };
  }
}

function printReport(report, preview) {
  if (report.file_error) {
    console.log("  ✗ " + report.file_error);
  }
  for (const e of report.errors || []) console.log("  ✗ " + e);
  for (const f of report.floors || []) {
    console.log(
      "  ✓ " +
        f.name +
        (f.test_exempt ? "" : "  [strict in tests/docs]") +
        " — " +
        f.description
    );
    console.log(
      "      paths: " +
        f.paths +
        "  keywords: " +
        f.keywords +
        "  patterns: " +
        f.patterns +
        "  exclude_paths: " +
        f.exclude_paths
    );
  }
  if (preview && report.preview_error) {
    // Preview is advisory, but its failure must be VISIBLE (C3 audit F-001) — a
    // silently missing preview reads as "no coverage to show".
    console.log("");
    console.log("  ! coverage preview failed (validation above is unaffected): " +
        report.preview_error);
  }
  if (preview && Array.isArray(report.preview)) {
    console.log("");
    console.log("  Coverage preview (tracked files from `git ls-files`; path floors — " +
        "keyword/pattern matchers apply to future diffs):");
    for (const p of report.preview) {
      const head =
        "  " +
        (p.nullified ? "! " : "• ") +
        p.name +
        ": " +
        p.path_matched +
        " file(s) covered by paths" +
        (p.path_excluded ? " (+" + p.path_excluded + " excluded)" : "") +
        (p.content_matchers
          ? "; " + p.content_matchers + " content matcher(s) apply to diffs"
          : "");
      console.log(head);
      for (const s of p.path_sample || []) console.log("      " + s);
      if (p.nullified)
        console.log(
          "      ^ this floor's paths match NO tracked file — check paths/exclude_paths"
        );
    }
  }
}

// --------------------------------------------------------------------------
// commands
// --------------------------------------------------------------------------

function cmdInit(root) {
  const target = path.join(root, RISK_REL);
  if (fs.existsSync(target)) {
    console.log("  ✓ " + target + " already exists — validating instead:");
    const res = runCheck(root, false);
    if (res.error) {
      console.log("  ✗ " + res.error);
      return 1;
    }
    printReport(res.report, false);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(SCAFFOLD, null, 2) + os.EOL, "utf8");
    console.log("  ✓ created " + target + " (empty — no floors defined yet)");
    console.log("");
    console.log("  Schema example:");
    console.log(SCHEMA_EXAMPLE);
  }
  console.log("");
  console.log(PROMPT);
  return 0;
}

function cmdCheck(root, preview) {
  const res = runCheck(root, preview);
  if (res.error) {
    console.log("  ✗ " + res.error);
    return 1;
  }
  printReport(res.report, preview);
  if (res.report.ok) {
    console.log("");
    console.log("  ✓ valid — " + (res.report.floors || []).length + " custom floor(s)");
    return 0;
  }
  return 1;
}

function cmdStatus(root, preview) {
  const res = runCheck(root, preview);
  if (res.error) {
    console.log("  ✗ " + res.error);
    return 1;
  }
  if (!res.report.exists) {
    console.log("  No custom floors defined in this repo (" + root + ").");
    console.log("  Define some: `npx @truverifai/init floors init` — or see");
    console.log("  `npx @truverifai/init floors prompt` for the agent-driven flow.");
    return 0;
  }
  printReport(res.report, preview);
  if (!res.report.ok) {
    console.log("");
    console.log("  ! problems above — broken entries are DISABLED until fixed");
    console.log("    (built-in floors are unaffected). Fix and re-run `tvai floors check`.");
    return 1;
  }
  return 0;
}

async function run(argv) {
  const args = argv.filter((a) => a !== "floors");
  const sub = args.find((a) => !a.startsWith("-")) || "status";
  const preview = args.includes("--preview");
  const root = gitRepoRoot(process.cwd());
  if (!root) {
    console.log("  ✗ not inside a git repository — custom floors are per-repo");
    return 1;
  }
  if (sub === "init") return cmdInit(root);
  if (sub === "check") return cmdCheck(root, preview);
  if (sub === "status") return cmdStatus(root, preview);
  if (sub === "prompt") {
    console.log(PROMPT);
    return 0;
  }
  console.log("usage: tvai floors [status|check|init|prompt] [--preview]");
  return 2;
}

module.exports = { run, PROMPT };
