# Runtime Failure Taxonomy Scan

Last refreshed: 2026-07-09.

Run:

```bash
bun run security:failure-taxonomy
```

This is an executable source-shape and behavior scan for runtime failure
classification. It makes health/import/bootstrap/faucet/transport/settlement
regressions fail loudly instead of drifting back to string parsing or hidden
warnings.

## Current Result

- `Contradiction` is fatal, non-retryable, and terminal when converted to a
  delivery failure.
- `TransientRace` is retryable and non-fatal.
- `ExpectedEmpty` is non-fatal, non-retryable, and safe to expose as empty
  product state.
- Runtime import readiness propagates typed fatal failures through
  `category`, `code`, `retryable`, `fatal`, and `failure` fields before it
  returns any manifest.
- Public health redaction exposes code/category/retryability/fatality while
  hiding internal failure messages.
- Faucet, proxy, bootstrap, market-maker, J-batch, delivery, prod-health, and
  runtime-import paths are all covered by a typed-failure source marker.
- Direct payment topology contradictions use fatal `DIRECT_PAYMENT_*`
  invariant errors instead of console output plus no-op returns.
- Direct payment debug traces use the structured `entity.payment` logger; the
  handler is guarded against raw `console.log` noise in core.
- Basic entity proposal/vote traces use the structured `entity.basic` logger;
  handlers are guarded against direct `console.*` noise in core.
- Entity factory creation/registration diagnostics use the structured
  `entity.factory` logger and are guarded against direct `console.*` noise.
- Entity consensus frame diagnostics and slow-profile notices use the
  structured `entity` logger and are guarded against direct `console.*` noise
  in core.
- Runtime entity-input replay/profile diagnostics use the structured
  `runtime.entity_inputs` logger and are guarded against direct `console.*`
  noise in core.
- Runtime storage DB open/close/block/recovery diagnostics use the structured
  `runtime.storage` logger and are guarded against direct `console.*` /
  `[storage-epoch]` noise in core.
- Standalone watchtower startup/sweep diagnostics use the structured
  `watchtower.standalone` logger and are guarded against direct `[WATCHTOWER]`
  / `[PUSH-WATCH]` console sweep output.
- Push dispute-watch target failures use the structured
  `watchtower.dispute_watch` logger and are guarded against direct
  `[PUSH-WATCH] target` console output.
- Orchestrator lifecycle helper diagnostics for HTTP drain timeout, stale child
  lease cleanup, and parent-liveness loss use structured orchestrator loggers
  and are guarded against direct `console.*` helper output.
- Browser jurisdiction discovery treats missing `/api/jurisdictions` as a
  structured debug fallback, but malformed browser config fails loud with
  `JURISDICTIONS_BROWSER_CONFIG_INVALID`; the loader is guarded against direct
  `console.*` noise in core.
- Node jurisdiction config loading uses structured `runtime.jurisdiction_loader`
  diagnostics, keeps the missing-file default deterministic, and is guarded
  against direct `console.*` / `new Date()` fallback noise in core.
- Entity input merge conflict/dedup diagnostics use the structured
  `entity.input.merge` logger and are guarded against direct `console.*` noise
  in core.
- Account input/open-account failures use structured `account.handler` and
  `account.open` loggers; empty account inputs fail fast with `ACCOUNT_INPUT_EMPTY`.
- Account committed followup diagnostics use the structured `account.followup`
  logger and are guarded against direct `console.*` noise in core.
- Account frame proposal diagnostics and slow-profile notices use the structured
  `account` logger and are guarded against direct `console.*` noise in core.
- Account consensus commit/validation diagnostics use the structured `account`
  logger and are guarded against direct `console.*` noise in core.
- Account transaction applicator rejects impossible embedded `account_frame`
  payloads without direct console output; debug diagnostics use `account.tx`.
- Same-jurisdiction orderbook matching diagnostics use the structured
  `orderbook.same` logger and are guarded against direct `console.*` noise.
- Settlement operation compilation rejects unknown operation types with
  `SETTLEMENT_UNKNOWN_OP_TYPE` instead of warning and skipping malformed input.
- Entity j-batch operation traces use the structured `entity.jbatch` logger;
  compact batch handlers are guarded against direct `console.*` noise in core.
- R2C debug traces use the structured `entity.r2c` logger; the handler is
  guarded against raw `console.log` noise in core.
- HTLC payment traces and failures use the structured `entity.htlc` logger; the
  handler is guarded against direct `console.*` noise in core.
- Dispute start/finalize traces and failures use the structured
  `entity.dispute` logger; the handler is guarded against direct `console.*`
  noise in core.
- Settlement progress and warning traces use the structured `entity.settle`
  logger; the handler is guarded against direct `console.*` noise in core.
- Debt ledger divergence diagnostics use the structured `entity.debt` logger;
  operator-visible state messages are preserved without direct `console.*`
  noise in core.
- Account delta validation now fails loud with `ACCOUNT_DELTAS_*` errors for
  missing/malformed inputs instead of returning partial maps after `console.*`
  warnings.

## Open Manual Review

- The taxonomy is still intentionally small: `ExpectedEmpty`,
  `TransientRace`, and `Contradiction`. If new categories are added, they must
  be reflected in `isRuntimeFailureSignal`, health redaction, import
  readiness, prod health smoke, and this scan.
- The scan proves wiring and key semantics. It does not replace product-level
  review of whether each individual operational failure code is assigned to
  the right category.
