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
- R2C debug traces use the structured `entity.r2c` logger; the handler is
  guarded against raw `console.log` noise in core.
- HTLC payment traces and failures use the structured `entity.htlc` logger; the
  handler is guarded against direct `console.*` noise in core.
- Dispute start/finalize traces and failures use the structured
  `entity.dispute` logger; the handler is guarded against direct `console.*`
  noise in core.
- Settlement progress and warning traces use the structured `entity.settle`
  logger; the handler is guarded against direct `console.*` noise in core.

## Open Manual Review

- The taxonomy is still intentionally small: `ExpectedEmpty`,
  `TransientRace`, and `Contradiction`. If new categories are added, they must
  be reflected in `isRuntimeFailureSignal`, health redaction, import
  readiness, prod health smoke, and this scan.
- The scan proves wiring and key semantics. It does not replace product-level
  review of whether each individual operational failure code is assigned to
  the right category.
