# xln mainnet release status

This is the only live TODO/NEXT file. It is a fail-closed release status, not a
product backlog; long-term work belongs in `docs/roadmap.md`.

## Current candidate — 2026-08-10

- Branch: `main` (the only writable release worktree).
- Open protocol/code blockers: **3 active remediation batches**.
- **ROUTED-DEBIT-AUTH-01 (P1):** routed payments authorize a recipient amount
  but do not bind a maximum sender debit. Owner must confirm the canonical
  `maxSenderDebit` semantics before the signed input/schema is changed.
- **SWAP-NET-AUTH-01 (P1):** a signed swap offer does not bind maximum fee or
  minimum net receive. Owner must confirm the canonical `maxFee` +
  `minNetReceive` semantics before Account/Entity consensus bytes are changed.
- **ACTIVE-TAB-01 (P2):** duplicated tabs can inherit one session tab ID and
  takeover publishes ownership before the old Runtime is fully quiescent.
  Awaiting owner confirmation to use Web Locks as the sole ownership authority,
  with quiesce-before-lock and an explicit Runtime resume after reacquisition.
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
