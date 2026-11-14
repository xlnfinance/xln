# Rejected remote input policy

Owner canon (2026-09-05): **a user or peer can never take a Runtime down.** Any input a
Runtime rejects because the *sender* is wrong (malformed remote EntityInput, a conflicting
user-authored prepare/materialize, an authenticated peer Account frame whose tx fails
validation) is a **rejection**, never a runtime fault.

The transition types the rejection and logs it **without reading process env**;
the Runtime loop reads the policy once per frame attempt and decides what the
frame does with the recorded outcome.

| mode | when | behaviour |
|---|---|---|
| fail-fast (default) | tests, dev, CI, any `NODE_ENV != production` | the rejection is logged **and surfaced to the caller of the Runtime loop**, so a hostile or buggy peer surfaces in tests |
| log-and-drop | `NODE_ENV=production` or `XLN_REJECT_FAIL_FAST=0` | the rejection is logged and the offending input/tx is dropped; the Runtime keeps serving |

`XLN_REJECT_FAIL_FAST=1` forces fail-fast even in production.

Surfacing is not a corrupted-state halt: the Runtime is never marked
mutated-and-unreadable by a sender-caused rejection. An ingress rejected before
mutation keeps its exact input queued and re-raises the typed error; a rejection
decided inside a frame is raised only after that frame is durable, so honest
work committed beside it is never rolled back.

## The log line to watch
- TS: `runtime.input_discard` → `entity_input.discarded` (error level, always emitted), and
  `REMOTE_INPUT_REJECTED` halts in fail-fast mode.
- TS: `runtime.entity_inputs` → `entity_input.rejected` (local ingress) / `entity_input.discarded`
  (remote ingress) with `inputIndex` and `rejectionCode` (error level, so it survives the
  production WARN threshold). The E2E fatal-log scanner treats these as audit lines, not halts:
  typed business rejections (e.g. insufficient HTLC capacity) are exercised on purpose.
- TS: `runtime.entity_inputs` → `entity_input.batch_tx_evicted` (warn): a deferred proposal
  attempt rejected its last tx and the Runtime evicted it from the mempool. The infra context
  that attempt consumed is journaled in the WAL under `entity:signer:height` (set-if-absent,
  `core/runtime/mempool/entity-inputs.ts`) so recovery replay rebuilds the same attempt,
  rejects the same tx and evicts it identically instead of failing with
  `ENTITY_REPLAY_CONTEXT_MISSING` (company-ipo scenario, 2-of-3 board, seed-dependent).
- Rust: stderr `[ERROR][reject] entity tx rejected and dropped …` and
  `[ERROR][reject] inbound account input rejected and dropped …`.

Every such line in a test, scenario or stand run is a bug to investigate (fail-fast makes
it a halt). In production it is the audit trail of peers to inspect.

## Where it is enforced
- TS `core/support/process/runtime-process.ts` `rejectFailFast()` — the only env read.
- TS `core/runtime/frame/intake/discard.ts` `rejectedIngressPolicy()` wraps it; the
  two callers are `discardRejectedEntityInput` (ingress rejected before mutation,
  during the frame's own rollback) and `applyRejectedIngressPolicy`, which
  `core/runtime/frame/process.ts` calls once per frame **after commit** on the
  `rejectedIngress` list the reducer carried out of the transition.
- TS `core/entity/tx/handlers/account/input-phases.ts` only *types* the rejection
  (`AccountFrameRejectionError`); the parent Entity tx is evicted in
  `core/runtime/mempool/entity-inputs.ts`, which records `peer-evidence` for the loop.
- Rust `entity-kernel/src/error.rs` `reject_fail_fast()` + `EntityKernelError::RejectedEntityTx`
  (handlers return it **before any mutation**), `kernel.rs` (cross-J tx drop),
  `resident.rs collect_rejected_inbound_inputs` (peer Account input drop).

Both engines evict exactly the rejected tx and keep the rest of the signer's queue: TS in
`core/runtime/mempool/entity-inputs.ts`, Rust in `kernel.rs` and `resident.rs`. In fail-fast
mode both halt.
