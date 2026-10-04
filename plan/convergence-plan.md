# Convergence to development, then main

Adopted by the owner on 2026-10-03. This supersedes the seven-step plan previously recorded here. Issue #178 is the authoritative work ledger.

## Authorization and ownership

The owner has resumed ledger updates and slice 1 only. Slices 2–4, promotion, contract changes and live deployment remain paused until explicitly released. A green slice is a prerequisite to the next authorization, not authorization itself.

Integration owner: Codex in the convergence chat. One writer owns overlapping code; independent reviewers inspect immutable candidates. Preserve pending branch heads and local-only work before closing anything. Existing review clears cover their exact heads, not later code.

Scope: opening accounts, payments, multi-hub HTLCs, swaps, disputes and recovery. Loans, cross-jurisdiction/watchtower coordination, live Sepolia qualification and structural refactoring are deferred. Complete Entity/Runtime duplication in Quint is not a promotion prerequisite. Keep the old walk until new-stack conformance is demonstrated.

## Slice 1: observation and recovery

Preserve #171 at 8fbd2a8abc152b5bcc4eb4d66185574191656e85 and #176 at e930e04a755b1b1ebb35b2fa4f637f64e8d2ceed. Audit their prospective combined merge with current development before merging. Existing Review A clears remain evidence at those heads; the combined audit covers integration. Merge #171, check its complete development run, then merge #176 and check its complete development run.

Land the outstanding corrections in the first integration PR afterward: skip readings at or below the WAL view on recovery; two-finalize coverage; repeat-start epoch/nonce/hash, right-side pruning, earliest lost block, own-start and stranger-finalize cases; partial log failure; named-set construction once per frame. Slice 1 ends only after these corrections, independent review of the tested commit, and the complete gate pass. New audit blockers must be resolved before their affected merge; do not interpret preserving heads as permission to merge an unaccepted new defect.

## Slice 2: lifecycle, admission and timing — paused

Before code, write the node's dispute duties once: read-wait, admission, forwarding, expiry, finalization reconciliation, recovery, account-local faults, evidence requirements, timing assumptions and owner outcomes. Use #171's read-wait design as the template; model transitions follow this document.

Combine #182 and #181. Carry hashlock, view block and revealed timestamp through Runtime inputs and WAL. Decisions require readings at their exact view; missing evidence delays dependent work. Value-holding daemons require registry capability. Compare the signed deadline in seconds, including slack exactly once. Validate slot length, missed-slot margin, poll delay, depth and inclusion lag against forwarding/reaction bounds.

#180 is not yet evidence: its backstop-only hlkback cell failed and subsequent cells did not run. Preserve that unsafe counterexample, implement actual admission transitions and run all cells under explicit assumptions; skipping a dangerous transition does not establish safety.

## Slice 3: finalization reconciliation — paused

Complete #177's nonce replay, unregistered counters, old-epoch acknowledgments, paid-intent removal, finalized balance accounting and owner notices.

Owner ruling overriding automatic retry: an unknown finalization preserves affected intents as unresolved, blocks automatic reissue and new spending on that Account, and emits a durable owner notice. Continue observation, recovery and protective claims. Resume idempotently only when evidence establishes the outcome; preserve this state across restart.

Reproduce and resolve the older duplicate-deposit and silently dropped chain-action reports with regression evidence, or evidence that current code already fixes them.

## Slice 4: integrated scenarios — paused

Complete #183/S9 and S9b, including hostile relayed finalization and upstream recovery. R-HOLD-DISSOLVE exists in development's register and implementation; recheck at the integration head and test it rather than recreate it. Remove temporary diagnostics and regenerate the scenario report. Close superseded drafts only when all changes and remaining obligations are mapped to replacements.

## Acceptance and CI

Each slice needs focused regressions, independent review of the exact tested commit, and a green complete development run. Stop unrelated merges while development is red.

Test:
- Duplicate-payment prevention, unresolved-intent recovery, WAL replay, nonce/acknowledgment boundaries, pruning versus transient faults, and loss of trace capability.
- Pre-revealed locks, exact signed-deadline and one-second-late boundaries, stale/missing registry readings, missed slots, delayed polling, hostile downstream finalization and upstream recovery.
- Every in-scope real daemon/contract scenario, including swaps, S9 and S9b, with no blocked or scaffolded steps.

Retain static checks, full tests, chaos seeds 0/12345/987654, Arrival, Quint and relevant contract vectors. Model changed safety properties; complete Entity/Runtime duplication is deferred. Close mutation gaps with behavioral evidence and document equivalent mutants explicitly.

Preserve R-GATE-CI-SPLIT: development PRs retain fast checks. Add the scenario runner to the aggregate full lane on branch pushes, promotion PRs into main, and scheduled/manual full runs. Pin the fork block, deployment manifest and tool versions. Use cached fork state backed, when necessary, by a dedicated authenticated RPC; never fall back to a public RPC. Report infrastructure failures distinctly from scenario failures; both fail visibly. Upload SHA-bound logs and scenario reports. Aggregate One gate rejects failed or unexpectedly skipped required jobs.

## Promotion — paused

The repository administrator changes rulesets; the agent supplies settings and verifies the effective result:
- Development requires One gate (tsc, rules, frozen, style), One gate (bun test), and Lane label.
- Main requires aggregate One gate, including the scenario job and strict failure/skip handling.

After all slices pass and blocking findings close, cut immutable promote/<sha> from a green development SHA. Run the complete promotion gate against its merge with main. Fix failures on development and cut a new snapshot; never move the existing snapshot. After explicit promotion authorization, merge with a merge commit, merge main back into development, and record SHA, evidence, scope and deferred work in #178. Never force-push.

## Refactoring after promotion — paused

First design self-contained dispute evidence, then simplify the reader. New bytecode requires deployment and compatibility planning. Measure optimized deployed bytecode and gas budgets before choosing event placement; remembered Account size headroom is unverified. DeltaTransformer executes through a view/staticcall path and cannot emit logs there without an architectural change.

Preserve the promoted regression fixtures. Expand conformance against the new Runtime/Entity/Account stack before deleting the old implementation or differential harness. Each refactoring PR must remain independently reviewable. Live Sepolia qualification is a separate milestone.
