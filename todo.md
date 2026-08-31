# xln mainnet release status

This is the only live TODO/NEXT file. It is a fail-closed release status, not a
product backlog; long-term work belongs in `docs/roadmap.md`.

## Active Rust H1 milestone — 2026-08-31

- Remove avoidable Account-input/outbox data movement. Current 1000-user,
  five-second profile moves 52.3 MB of Runtime inputs and 45.5 MB of outbox;
  31.0 MB of the outbox is repeated frame/dispute Hanko material.
- Explain and reduce the `w1 -> w4` full-flow gap. Current diagnostic Account
  work improves 2.55x per Account input, while end-to-end drain improves only
  1.27x because W4 seals 51 Runtime frames / 14,655 Account inputs while W1
  seals 21 / 10,526 for the same 5,000 payments. The Account outcome trace has
  zero `FrameDuplicate`; isolate Account-frame fragmentation/bundling rather
  than misclassifying the ledger's repeated appearances as duplicate apply.
- Collapse the production Entity plan to the canonical three stages. Today an
  interleaved local transaction can split one frame into multiple
  `AccountRange` worker visits; the target is one Account ingress batch, one
  Entity financial batch, and one Account proposal batch.
- Collapse `commit_paybook_changes` from two shared-pool dispatches into one
  `256 shard -> changes[]` dispatch. Current code first maps every change into
  a mutation and then wakes the pool again for active radix slots; measured
  Paybook commit wall is 45 ms at W1 versus 168 ms at W4 for the same payment
  smoke, proving coordination overhead instead of scaling.
- Remove the two conditional post-proposal Account continuations from the
  normal architecture: failed-forward compensation must be decided before
  Paybook emits proposal work, and locally-produced settlement Hankos must be
  attached at publication instead of mutating the Account candidate after
  Entity certification.
- Remove derived Runtime-frame touch lists from the canonical WAL format once
  the TS storage/UI readers derive their views from canonical input/output
  rows; do not retain both representations.
- Eliminate duplicate EntityInput encoding: admission currently encodes the
  complete input only to measure it, then Runtime projection encodes it again
  inside the frame. One canonical byte representation must cross both steps.
- Run fresh, sequential Rust H1 payment saturation evidence at 5,000 users for
  20 seconds with W1 and W4, then run the same-chain swap gate. Report only
  committed operations with zero pending Account ACKs and zero transport loss.
- Run `bun run check`, checkpoint the coherent change on `main`, and push only
  after the focused Rust parity tests and live H1 gates are green.

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
- fully green unit tests, deterministic scenarios, and browser E2E on the same
  immutable candidate bytes

Completed work and stale findings are deleted rather than retained as open
checkboxes. Any new blocker must be added here immediately and removes release
authority until fixed and re-gated.
