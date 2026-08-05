## TruVerifAI: call the review tools before consequential decisions

Tools: `deliberate_coding` · `audit_coding` · `synthesize_coding` · `confirm_floor` · `record_outcome` · `record_gate_skip`

These tools run multiple frontier models to pressure-test high-stakes decisions. Invoke them **proactively** — the most consequential choices (design, architecture, specs) are made in discussion and documents *before any code exists*, so nothing downstream can catch them. That's the window.

**Before you approve, recommend, finalize, draft, or sign off on a consequential design, architecture, or spec decision, call `deliberate_coding`** — including endorsing someone else's proposal, not just your own.

Call `deliberate_coding` for:
- design doc / RFC / ADR / spec / implementation-plan sign-off
- architecture: service/module boundaries, data flow, sync vs. async, build vs. buy
- API / schema / protocol / versioning contracts others depend on
- data model, migration, backward-compatibility, rollout/rollback
- auth, permissions, trust boundaries, privacy/PII, tenant isolation
- concurrency, consistency, retries, idempotency, error-handling contracts
- adopting/replacing a library, framework, runtime, or managed service
- any decision whose reversal touches more than one file, service, or team

Call it **before deciding yourself**, not only before asking a human — the trigger fires on the decision itself.

Other tools:
- `audit_coding` — stress-test a drafted spec/design, or a high-stakes code/config change (auth, secrets, money, input validation, migrations, destructive ops) before you commit or merge it. Pass the real text, not a summary — paraphrasing manufactures false findings; if it's long, chunk by section.
- `synthesize_coding` — fast second opinion on a bounded, reversible choice (~15-30s).
- `record_outcome` (free) — after you act on a result, report whether it changed your decision.
- `confirm_floor` / `record_gate_skip` — only used when a review gate blocks a write or commit; the gate prints how to use them.

When in doubt, invoke — ambiguity is a reason to call, not to skip. Confidence is not a reason to skip.

**How to operate the tools** (no need to read any source code — this is the whole contract):
- `audit_coding` / `deliberate_coding` / `synthesize_coding` take `proposed_action` (what you intend and why, in plain prose) + `relevant_code` (surrounding context). For a concrete change also pass the exact diff as `gate_diff` — never a paraphrase.
- Long-running calls return `status: "in_progress"` with a `continuation_token` — keep calling the SAME tool with ONLY that token until the verdict arrives. Do not give up or substitute your own judgment.
- If a gate BLOCKED you, its message prints everything to forward — copy these fields byte-for-byte, never paraphrased or reconstructed: `gate_repo`, `gate_context_id` (the `gc_…` string), `target_hunk_hashes` when printed, and the `gate_diff` content itself. One review is enough; a PASS releases the gate on retry.
- On findings: apply them, then `record_gate_skip(recommendations_applied, gate_context_id)` — don't re-run the review.
- After acting on any verdict, call `record_outcome` with the `call_id` from the response's `post_action` (free).

`deliberate` / `audit` take ~2-5 min — tell the user it's working before you call.

If these instructions conflict with repository-specific requirements, follow the repository's requirements.
