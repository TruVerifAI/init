// Detect which AI coding agents exist on this machine / in this repo.
// Detection is by config-directory presence — cheap, offline, no exec.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = os.homedir();

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function which(cmd) {
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    execFileSync(probe, [cmd], { stdio: "pipe" });
    return true;
  } catch (e) {
    return false;
  }
}

/** All platform detections. `cwd` matters for repo-level installs. */
function detect(cwd) {
  cwd = cwd || process.cwd();
  const inRepo = exists(path.join(cwd, ".git"));
  return {
    in_git_repo: inRepo,
    claude: exists(path.join(HOME, ".claude")),
    codex: exists(path.join(HOME, ".codex")),
    copilot: exists(path.join(HOME, ".copilot")) || which("copilot"),
    // X4 (2026-08-14): this used to be a two-way win32/else split whose else
    // branch was `~/.config/Code` — the LINUX path. macOS keeps VS Code under
    // `~/Library/Application Support/Code`, so on a Mac the branch never
    // matched and detection fell through to `~/.vscode`, which exists only if
    // the user has ever installed an extension. A fresh, portable, or
    // custom --user-data-dir install went undetected, and `tvai init` then
    // silently skipped BOTH the VS Code hook config and its MCP server config.
    //
    // mcpconf.vscodeUserDirs() already resolves all three platforms correctly
    // (and honors TVAI_HOME_OVERRIDE and a redirected %APPDATA%, which the old
    // hand-rolled path did not); reuse it rather than keep a second, drifting
    // copy of the same knowledge (Rule 8).
    //
    // The require is LAZY purely to keep this module import-light and
    // order-independent — the graph is already acyclic (detect -> mcpconf ->
    // config, no reverse edge), so do not "fix" this by hoisting on the
    // assumption it is dodging a cycle (audit mcp_d7ff37ae F-005).
    //
    // DELIBERATE NARROWING (F-003): vscodeUserDirs() requires the `User/`
    // subdirectory to exist, which VS Code creates on first launch — the old
    // check looked for the parent `Code/`. So an installed-but-never-launched
    // VS Code now reads as undetected. That is the safe direction: the cost is
    // one skipped optional install (writeVSCode() already no-ops without a
    // profile dir, and re-running `tvai init` after first launch picks it up),
    // whereas the macOS bug this replaces silently skipped VS Code for users
    // who were actively using it.
    vscode:
      exists(path.join(HOME, ".vscode")) ||
      require("./mcpconf").vscodeUserDirs().length > 0,
    cursor: exists(path.join(HOME, ".cursor")),
    gemini: exists(path.join(HOME, ".gemini")),
    // Antigravity shares ~/.gemini/config; detect its plugins dir specifically.
    // Contract (audit F-002, 2026-08-02): means "the Antigravity user config
    // area exists" (~/.gemini/config is Antigravity's user-level hooks home
    // per its docs), NOT "this repo is an Antigravity workspace". Over-
    // trigger cost is one inert .agents/hooks.json no other host reads.
    antigravity: exists(path.join(HOME, ".gemini", "config")),
  };
}

module.exports = { detect, exists, which, HOME };
