# @truverifai/init

One command to connect your AI coding agents to [TruVerifAI](https://truverif.ai)
— multi-model review tools plus local pre-commit/pre-write review gates — on
Claude Code, Codex CLI, Cursor (IDE + CLI), VS Code / GitHub Copilot,
Gemini CLI, and Antigravity.

```
npx @truverifai/init          # detect agents -> browser login -> install gates + tools -> verify
npx @truverifai/init doctor   # re-verify anytime: gates armed, tools connected, key valid
npx @truverifai/init logout   # remove the API key from every config this tool wrote
```

MIT-licensed. **Zero runtime dependencies** — this package is plain,
unminified JavaScript and Python; `npm pack @truverifai/init` and read every
line. There is no build step and no transitive supply chain.

## What this installs, exactly

`init` runs as you, interactively, and prints every file it touches. The
complete list:

**Its own home — `~/.truverifai/`**
- `config.json` — your `tvai_…` API key (minted via browser device-flow
  login; this process never sees a password).
- `gates/current/` — the review-gate code (Python + a Node launcher),
  vendored from this package's `vendor/` directory.
- `.nudge_state.json`, `gate_state/` — local rate-limit / state files.

**Per detected agent (user-level; only for agents found on your machine)**
- Claude Code: the plugin's `api_token` option, and one `permissions.allow`
  entry (`mcp__plugin_panel-review_truverifai`) in `~/.claude/settings.json`
  so Claude's auto-mode classifier permits the free gate-release calls.
  Additive merges only — the file is backed up first, never created, and
  never has anything removed.
- Codex CLI: an MCP server block (between `TRUVERIFAI` markers) and
  `[features] hooks = true` in `~/.codex/config.toml`; `~/.codex/hooks.json`.
- Cursor: `~/.cursor/hooks.json` (gates) and `~/.cursor/mcp.json` (tools).
- Copilot CLI: `~/.copilot/mcp-config.json`.
- VS Code: your user `mcp.json`.
- Gemini CLI: `~/.gemini/settings.json` (tools entry).

**Per repository (written in the repo you run `init` from, with a prompt)**
- `.github/hooks/truverifai-gate.json` + `truverifai-vscode.json`
  (Copilot CLI / VS Code gate hooks), `.gemini/settings.json` (Gemini
  hooks), `.agents/hooks.json` (Antigravity hooks).
- Optional agent-rules blocks (marked `TRUVERIFAI_RULES_START…END`) in
  `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` — you are asked first.
- `tvai hook` (separate command) installs a git `pre-commit` fallback.

`logout` strips the API key from every config listed above. Nothing is
installed as a service, daemon, or startup item; the gates only run when
your agent host invokes its hooks.

## What leaves your machine

- **Login:** a device-flow handshake with `truverif.ai` mints your API key
  in the browser.
- **Gate checks (on risky writes/commits):** the gates POST to
  `api.truverif.ai` a hashed repo fingerprint (SHA-256 of your git remote
  URL or repo path — the raw path/URL never leaves the machine),
  content hashes of the changed hunks, and the local classifier's category
  labels and scores. **Not** your source code, and **not** your file paths
  (only coarse path-class tags like "test/docs").
- **Review tools (`audit_coding` etc.):** send only what your agent
  explicitly passes when it invokes a review — that is the product: the
  diff/context you choose to submit is analyzed by multiple frontier
  models.
- **Update check:** gate responses may include a "newer version available"
  note computed server-side against the public npm registry; the client
  sends only its own version string.
- Diagnostics (`TVAI_PAYLOAD_LOG`) are **local-only and opt-in** — nothing
  is uploaded.

The gates **fail open by design**: if our server is unreachable or anything
errors, your commit/write proceeds and a visible notice says the change was
not gated. This tool never blocks your work on its own failure.

## Verifying this package

The full source is public at
[github.com/TruVerifAI/init](https://github.com/TruVerifAI/init) — every
release is synced there. To verify a tarball by hand:
`npm pack @truverifai/init`, extract, and diff against the repo —
`bin/tvai.js`, `lib/*.js`, and `vendor/gates/*.py` are the entire runtime
surface, dependency-free. The gate code (`vendor/gates/`) is also
published at
[github.com/TruVerifAI/claude-plugins](https://github.com/TruVerifAI/claude-plugins)
(`plugins/panel-review/hooks/`). Build provenance attestation (CI publish
with cryptographic linkage to this repo) is the planned next step.

## Support

- Setup page: https://truverif.ai/settings/mcp
- Issues / questions: support@truverif.ai
