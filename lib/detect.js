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

/** Walk up from `dir` looking for `.git`. The fallback when git cannot be run.
 *
 *  `.git` is a DIRECTORY in a normal clone and a FILE in a worktree or
 *  submodule, so this tests existence, not type. Bounded by the filesystem root
 *  — `path.dirname("/")` is `"/"` and `path.dirname("C:\\")` is `"C:\\"`, which
 *  is the loop's exit. */
function gitRootByWalk(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (exists(path.join(cur, ".git"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

// One CLI invocation resolves the root up to three times (detect, then
// installGitPrecommit / removeHooks calling in directly). The repo root cannot
// move mid-run, so cache per directory: saves two subprocess spawns and, more
// to the point, two chances to sit on a cold network mount (audit F-007).
const _rootCache = new Map();

/** The absolute repo ROOT containing `cwd`, or null when not in a work tree.
 *
 *  X11c (2026-08-15): this used to be a bare `exists(cwd/.git)`, so running
 *  `init` from a SUBDIRECTORY of a repo answered "not a git repo" — a false
 *  statement that then silently skipped the git pre-commit gate, the Gemini and
 *  Antigravity hook configs and the rules step, and sent Copilot's config to the
 *  user level instead of the repo. Asking git handles worktrees and submodules,
 *  where `.git` is a FILE rather than a directory; the walk below handles them
 *  too, so the answer does not depend on git being runnable.
 *
 *  Lives HERE, not in hosts.js, because both modules need it and hosts.js
 *  already imports this one (detect -> hosts would be a cycle). `path.resolve`
 *  normalizes git's forward slashes to the platform separator so the path we
 *  print matches the paths every other line prints. */
function gitRepoRoot(cwd) {
  cwd = cwd || process.cwd();
  if (_rootCache.has(cwd)) return _rootCache.get(cwd);
  const r = _gitRepoRootUncached(cwd);
  _rootCache.set(cwd, r);
  return r;
}

function _gitRepoRootUncached(cwd) {
  try {
    // execFileSync + array args, NOT execSync + a shell string (audit F-007):
    // execSync goes through cmd.exe on Windows, which searches the CURRENT
    // DIRECTORY before PATH — so `git rev-parse` run inside a freshly cloned
    // untrusted repo would execute a `git.cmd` sitting in it. Without a shell,
    // a .cmd/.bat cannot be launched at all. Matches `which()` above.
    //
    // `.trim()` is load-bearing: git appends a newline, and path.resolve does
    // NOT strip it — every fs call on the result would then fail.
    //
    // 3s, not the 10s this started at: giving up early is now cheap, because
    // the fallback is a directory walk that reaches the same answer. While the
    // fallback was a cwd-only check, an expiry silently re-created the very bug
    // this function fixes, so waiting was the lesser evil. It no longer is.
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
    });
    const root = String(out).trim();
    if (root) return path.resolve(root);
  } catch (e) {
    /* Bare catch, deliberately: not a repo, git absent (ENOENT), git hung
       (timeout), EPERM, an antivirus shim, a corporate wrapper — every one of
       them must land on the walk below rather than escape. detect() runs at the
       top of every command, so a throw here would take the whole CLI down
       (audit F-001). */
  }
  // No git binary reachable. Walking up still finds the root, so the
  // subdirectory fix does NOT depend on git being executable — which also
  // closes the Windows PATH configurations where `git` resolves only through a
  // shell (audit F-002). Previously this checked cwd alone and answered "not a
  // repo" from any subdirectory, i.e. it re-created the bug it was covering.
  return gitRootByWalk(cwd);
}

/** All platform detections. `cwd` matters for repo-level installs.
 *
 *  `git_root` is the base every repo-scoped write should use — NOT `cwd`, which
 *  may be a subdirectory. `in_git_repo` is derived from it so the two can never
 *  disagree. */
function detect(cwd) {
  cwd = cwd || process.cwd();
  const root = gitRepoRoot(cwd);
  return {
    in_git_repo: root !== null,
    git_root: root,
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

module.exports = { detect, exists, which, gitRepoRoot, HOME };
