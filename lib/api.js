// Minimal HTTPS JSON client (Node built-ins only — the installer must run via
// `npx` with zero dependency installs beyond itself).
"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");

function requestJson(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === "http:" ? http : https;
    const data = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = mod.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: url.pathname + url.search,
        headers: Object.assign(
          { "Content-Type": "application/json", "User-Agent": "tvai-cli" },
          data ? { "Content-Length": data.length } : {},
          headers || {}
        ),
        timeout: 30000,
      },
      (res) => {
        let chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (e) {
            /* non-JSON body */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// --- device flow -----------------------------------------------------------

async function deviceStart(base, label, platforms) {
  const r = await requestJson("POST", base + "/api/device/code", {
    label,
    platforms: platforms.join(","),
  });
  if (r.status !== 201 || !r.json) {
    throw new Error("device/code failed (HTTP " + r.status + ")");
  }
  return r.json;
}

async function devicePoll(base, deviceCode) {
  const r = await requestJson("POST", base + "/api/device/token", {
    device_code: deviceCode,
  });
  if (!r.json) throw new Error("device/token failed (HTTP " + r.status + ")");
  return r.json;
}

/** Poll until complete/denied/expired. Honors interval + slow_down. */
async function deviceWait(base, deviceCode, intervalSec, onTick) {
  let interval = Math.max(intervalSec || 5, 5);
  for (;;) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await devicePoll(base, deviceCode);
    if (res.status === "pending") {
      if (onTick) onTick();
      continue;
    }
    if (res.status === "slow_down") {
      interval = Math.max(interval, (res.interval || interval) + 2);
      continue;
    }
    return res; // complete | denied | expired
  }
}

// --- health / key validation ----------------------------------------------

async function healthCheck(base) {
  const r = await requestJson("GET", base + "/api/analytics/health", null);
  return r.status === 200;
}

/** Validate the key against the same endpoint the gates use, with a benign
 *  probe body (fingerprint of nothing; no repo data leaves the machine). */
async function keyCheck(base, key) {
  const r = await requestJson(
    "POST",
    base + "/api/mcp/receipts/check",
    { repo: "tvai-doctor-probe", hunks: [] },
    { Authorization: "Bearer " + key }
  );
  return { valid: r.status === 200, status: r.status };
}

module.exports = { requestJson, deviceStart, devicePoll, deviceWait, healthCheck, keyCheck };
