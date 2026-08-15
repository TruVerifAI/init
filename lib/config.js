// ~/.truverifai/config.json — the cross-platform config file the gate core
// reads as the LAST level of its resolution chain (TVAI_* env > host-native >
// this file). Written 0600: it holds the API key.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Sandbox guard, matching mcpconf.homeDir() (audit mcp_e78430be F-003). Every
// module that touches real user files must resolve home the SAME way, or the
// guard is only as strong as its weakest module — proven while building `tvai
// uninstall`: a run with HOME/USERPROFILE overridden still reached the real VS
// Code profile through %APPDATA%, because one module resolved home its own way.
// This file holds the API key and names the directory `uninstall` deletes, so
// it is exactly the wrong place to be the weak module.
function homeDir() {
  return (process.env.TVAI_HOME_OVERRIDE || "").trim() || os.homedir();
}

const DIR = path.join(homeDir(), ".truverifai");
const FILE = path.join(DIR, "config.json");
const GATES_DIR = path.join(DIR, "gates", "current");

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

/** Read for a WRITE path. Distinguishes two cases `read()` deliberately blurs:
 *
 *   - no file yet            -> {} , fine, we are creating it
 *   - file exists, won't parse -> THROW
 *
 *  `read()` returns {} for both, which is right for callers that just want a
 *  value. It is catastrophic for a caller about to write the merge BACK: this
 *  file holds the user's API key, so a partial write, a crash mid-save, or any
 *  corruption would make the next `gates set` silently replace the whole file
 *  with just that one setting. Reproduced before fixing: a truncated
 *  config.json plus one `gates set` destroyed the stored key.
 *
 *  Refusing to write is the right failure — the file is recoverable by hand,
 *  the key is not (audit mcp_bf1f1d0b C-1). */
function readForWrite() {
  if (!fs.existsSync(FILE)) return {};
  let raw;
  try {
    raw = fs.readFileSync(FILE, "utf8");
  } catch (e) {
    throw new Error("cannot read " + FILE + " (" + e.message + ")");
  }
  if (!raw.trim()) return {};
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("not an object");
    return o;
  } catch (e) {
    throw new Error(
      FILE + " exists but is not valid JSON, so writing to it would discard "
      + "whatever it holds — including your API key. Fix or delete the file, "
      + "then retry. (" + String(e.message).slice(0, 60) + ")"
    );
  }
}

function write(updates) {
  const merged = Object.assign({}, readForWrite(), updates);
  fs.mkdirSync(DIR, { recursive: true });
  // Write then chmod: on Windows chmod is a no-op (the profile dir ACL is the
  // protection there); on POSIX 0600 keeps the key owner-readable only.
  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(FILE, 0o600);
  } catch (e) {
    /* windows */
  }
  return merged;
}

/** Delete keys entirely, so an option falls back to its shipped default rather
 *  than being pinned to a value that merely equals the default today (`gates
 *  reset`). write() merges and therefore cannot remove. */
function unset(keys) {
  const merged = readForWrite();
  for (const k of [].concat(keys)) delete merged[k];
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(FILE, 0o600);
  } catch (e) {
    /* windows */
  }
  return merged;
}

function baseUrl() {
  return (
    (process.env.TVAI_API_BASE_URL || "").trim() ||
    (read().base_url || "").trim() ||
    "https://api.truverif.ai"
  ).replace(/\/+$/, "");
}

function apiKey() {
  const env = (process.env.TVAI_API_KEY || "").trim();
  if (env) return env;
  const cfg = read();
  return (cfg.api_key || cfg.api_token || "").trim();
}

module.exports = {
  DIR, FILE, GATES_DIR, read, readForWrite, write, unset, baseUrl, apiKey,
};
