# pure/ backlog

Open work on the xln.ts rewrite. GitHub Issues are disabled for this repository.

## Prune typed Account handler checks now covered by og's validator

Every Account tx now goes through `ogHandlerChecks` in `applyAccountBody` before the typed handlers apply it. Those
are og's handler checks, in og's order and with og's refusal text. That text is consensus: a refused peer frame
lands in the Entity frame events, and the frame hash covers them.

Several typed handlers still repeat checks the gate has already made. Those checks can no longer fire and now act
only as a safety net. For example:

- the `payment` arm's `paymentRoute` (`paymentFailure` already runs it);
- `htlcLock`'s lock id, duplicate, expiry, amount and lock-cap checks;
- `setCreditLimit`'s negative and maximum checks (it is also a domain function used elsewhere, so keep it total
  there).

Task: for each arm in `applyArm`, remove the checks the og validator dominates. BodyError variants that no longer
occur should go too. Keep the domain algebra (`move`, `spend`, `setCreditLimit`) total where other callers use it.
`j_event_claim` and `settle_transition` stay as they are: og words their text from where the apply failed.

Guard: the full suite and `bun run test:seeds` must pass, and the runtime-loop differentials (`diff/scenario*.test.ts`)
must stay byte-identical. When the gate went in, no accept/reject decision changed, so a pruning step that changes
one is a bug.
