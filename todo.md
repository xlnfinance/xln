# xln live release checklist

This is the **only live TODO/NEXT file**. Git history contains the retired
0.1.9–0.1.11 handoffs; they are not current release evidence.

## Candidate

- Target: `v0.1.12` after the mandatory gates pass.
- Branch: `ai/routed-provenance`.
- Candidate implementation head: current HEAD of `ai/routed-provenance`; freeze
  the exact SHA when the release gate starts.
- Base: `edfb178be`; production remains on the published `v0.1.11` until this
  candidate is fully verified.
- Frozen Core: unchanged at
  `0x4eccf4492e5d085b24162f86d327e003c36b7e2a90ad527db1653fde391946a7`.

## Closed on this candidate

- Cross-j WAL records preserve authenticated source Runtime provenance.
- Same-chain resting-order match commits both offers and queues both resolves
  in one hub Entity frame; the default Runtime frame delay is zero.
- Full debug Env snapshots are periodic (default every 100 R-frames); the WAL
  still commits every state-changing R-frame and creates no heartbeat frames.
- Profile Hanko signs the final post-state descriptor in the same Entity frame.
- `lock-ahb` validates terminal Entity-finalized chain evidence and is part of
  the default RPC release scenario gate.
- Runtime/storage profiling emits ordered phase durations. On the fixed
  16-account/4-payment storage benchmark, open is ~3.48 s, admission ~399 ms,
  settlement ~883 ms, parity mismatches are zero, and physical writes remain
  ~1–2 ms per R-frame.
- Redundant replica-meta cloning and repeated lineage endpoint hashing are
  removed. Storage CPU fell from ~1206 ms to ~946 ms across the same 10-frame
  benchmark (~21.6%).
- Control ingress receipts observe every durable R-frame directly (not sparse
  debug history) and accumulate capped command batches across frames. Reset
  failures remain latched until a fresh reset explicitly clears them.

## Release gates still required

1. Finish `bun run gate:release` on the immutable candidate. It includes the
   newly gated `lock-ahb` RPC scenario and stops at the first failed phase.
   The bounded soak remains a separate non-release gate by owner decision.
2. Run the public-network acceptance gate with `bun run gate:mainnet`.
3. External audit handoff: `docs/security/external-audit-brief.md`.
4. Merge to `main`, push authoritative source, perform a fresh production
   redeploy/reset, verify health and browser console, then publish/tag `v0.1.12`.

Already green: `bun run check`, focused same-chain Chromium, focused cross-j
one-click Chromium, and strict browser console health. Mascot remains hidden
and excluded.

## Post-release storage work

- Current live replica metadata still carries exact full validator-local Entity
  state at every R-frame boundary. LevelDB overwrites the logical key, but old
  values consume log/SST space until compaction. Replacing this with compact
  per-frame local metadata plus full checkpoint metadata requires a recovery
  schema change and dedicated crash-boundary tests; do not mix it into the
  release candidate without completing that proof.
- Keep the full canonical replay oracle per R-frame. Optimize it only through
  proven incremental/cached inputs, never by weakening its coverage.

## Working rules

- L1 narrow test, then one targeted L2 flow, then broad/release gates.
- Never run `bun run frozen-core:approve`.
- WAL commit precedes outbox dispatch. Watchtower backup remains optional and
  cannot block local durability.
- No compatibility migration is required for this testnet release; production
  deployment is a fresh reset.
