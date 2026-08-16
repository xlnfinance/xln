# xln mainnet release status

This is the only live TODO/NEXT file. It is a fail-closed release status, not a
product backlog; long-term work belongs in `docs/roadmap.md`.

## Current candidate — 2026-08-14

- Branch: `main` (the only writable release worktree).
- Open mainnet protocol/code blockers: **5**. Testnet remains the active product target.
- The executable mainnet gate currently blocks uncapped launch until aggregate
  financial-risk enforcement and the bilateral/on-chain lending covenant are real.
- Live Runtime/Entity/Account replicas must contain only the current committed
  head and bounded in-flight coordination. Historical frames, terminal orders
  and finalized J-event bodies are moving to their dedicated LevelDB history
  stores; release remains blocked while any live historical collection remains.
- Runtime/Entity/Account/Book candidates must use separate recomputable
  persistent-Merkle overlays. A frame may not clone or traverse the complete
  machine, and throughput evidence is not valid until every matched swap is
  bilaterally committed with all Runtime/outbox queues at zero.
- Cross-j Pulls intentionally use independent jurisdiction dispute clocks. Any
  observed leg dispute must make the user or hub Runtime atomically start every
  sibling dispute in one WAL candidate and port Source evidence to Target. This
  best-effort recovery invariant does not impose a shared settlement epoch and
  does not disable the product.
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
- `bun run gate:mainnet-preflight` (owner explicitly excluded the soak gate)
- post-deploy `bun run prod:health`

Completed work and stale findings are deleted rather than retained as open
checkboxes. Any new blocker must be added here immediately and removes release
authority until fixed and re-gated.
