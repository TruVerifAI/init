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
    vscode:
      exists(path.join(HOME, ".vscode")) ||
      exists(
        path.join(
          HOME,
          process.platform === "win32" ? "AppData/Roaming/Code" : ".config/Code"
        )
      ),
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
