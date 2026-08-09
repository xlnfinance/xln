# xln mainnet release status

This is the only live TODO/NEXT file. It is a fail-closed release status, not a
product backlog; long-term work belongs in `docs/roadmap.md`.

## Current candidate — 2026-08-09

- Branch: `main` (the only writable release worktree).
- Open protocol/code blockers: **3 active remediation batches**.
- **CHAIN-NUMBER-01 (P1):** `Account.sol` can store/emit a nonce above
  `Number.MAX_SAFE_INTEGER`, while Runtime correctly rejects that event rather
  than rounding it. Inventory every Solidity number crossing into a Runtime
  `number`; enforce the same bound at the on-chain write boundary and retain
  Runtime rejection as defense in depth. Money and true uint256 quantities
  remain `bigint` end to end.
- **DISPUTE-DRAFT-01 (P1):** finalized dispute cleanup deletes snapshot maps
  and peer seals but leaves `currentDisputeProof*`; after reopen, a stale
  higher local draft can outrank the new seal without its deleted snapshot and
  freeze `disputeStart`. Clear the whole draft authority tuple atomically at
  finality/reopen and prove finalize → reopen → second dispute at L1/L2.
- **CLI-OUTCOME-01 (P1):** money commands pass `() => true`, ignore a false
  Runtime drain result, and the daemon labels accepted input as `paid` or
  `swapped`. Match the frontend command contract: prove the exact RuntimeInput
  committed, fail on drain timeout, and report only `queued/committed` unless a
  financial outcome was actually observed.
- **CLI-LIFECYCLE-01 (P2):** session teardown closes Runtime and infra DBs in
  parallel, racing infra writes against Runtime/P2P quiescence. Close Runtime
  first, then infra, and test error propagation.
- **CLI-SOCKET-01 (P2):** the unlocked wallet daemon socket has no explicit
  owner-only permissions. Create its parent as `0700`, chmod the bound socket
  to `0600`, and assert both modes.
- **AMOUNT-PARSER-01 (P2):** CLI, Settlement, shared asset inputs, Graph3D and
  BigIntInput silently truncate fractional digits beyond token precision.
  Route every signing/submission surface through one strict parser; display
  formatting may round but authorization inputs must reject excess precision.
- **FRONTEND-SUBMIT-01 (P3):** CreditForm permits duplicate in-flight extend
  and request submissions. Add one fail-loud submitting guard and disabled UI.
- **DOCS-XSS-01 (P3):** DocsView feeds catalog Markdown HTML directly to
  Svelte. Route it through the existing `sanitizeRenderedHtml` boundary.
- **TOOLING-COOP-01 (P2):** `public-proof-smoke.ts` still expects cooperative
  dispute finalization although the canonical contract deliberately reverts
  it with `E2`. Replace the stale smoke path; do not add a compatibility route.
- Hash-ladder publication is an independent Sprites-like `processBatch`
  operation authenticated by the publishing Entity. The registry stores the
  account-scoped ladder record; it does not authorize against, retain, or
  promote a dispute ProofBody.
- `proposerIsLeft` is signed proof-header consensus data. LEFT wins an equal
  nonce; a strictly newer nonce wins regardless of side.
- Pull-free early finalization is available only to the non-starter as fresh
  mutual acceptance. The starter waits until T; every Pull finalization waits
  until T. Watchtowers may lock a newer signed counter-proof before T and may
  execute it only at T.

## Release evidence contract

The candidate is publishable only after all commands below are green on the
same bytes and an independent contract/runtime audit reports no blocker:

- `bun run check`
- `bun run gate:release`
- `bun run gate:mainnet`
- post-deploy `bun run prod:health`

Completed work and stale findings are deleted rather than retained as open
checkboxes. Any new blocker must be added here immediately and removes release
authority until fixed and re-gated.
