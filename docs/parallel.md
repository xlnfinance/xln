# Hub throughput: state, cost model, and the parallel plan

Status as of 2026-08-23 (main @ `e12de5c42`). Written as a hand-off: every number
below was measured on this tree with the commands in §7; claims without a
measurement are marked *(unverified)*.

## 1. Where we are

1000 users, one hub (H1), 5 lane processes × 8 workers × 25 user runtimes.

| workload | live (authoritative) | hub replay (pure hub CPU) |
|---|---|---|
| payments, 1000 users × 1/s × 10 s (10k) | **332 tps** (was 234 at session start) | **553 tps** |
| payments, 1000 users × 3/s × 4 s (12k) | **413 tps** | — |
| same-J swaps, 10k offers | 309 matched / 546 settled offers/s | **585 trades/s = 1170 offers/s** |
| mixed (swaps+payments) | red on this tree AND on the pre-optimisation checkpoint (`8c5ccf197`): unmatched tail of ~50 live orders from the mixed generator; not a consensus regression | — |
| cross-J | harness runs exactly ONE atomic swap (`worker-runtime.ts:377`); 354 ms settle; no load harness exists | — |

Live hub main thread is ~100% busy during the load window. Per payment on the
hub main thread (12k run, op-counters): apply 1.8 ms (frameApply 0.9,
stateRoot 0.25, wireFit 0.2, manifestSignatures 0.1, rest 0.3), save 0.44 ms,
dispatch 0.13 ms → ~2.4 ms/payment ≈ 413 tps.

### The cost is per touched Account per frame, not per payment

Fitting `t_frame = F + n·c` on the 10k (23 frames, 435 inputs/frame, 1.31 s/frame)
and 12k (21 frames, 571 inputs/frame, 1.38 s/frame) runs gives **c ≈ 0.5 ms per
input, F ≈ 1.1 s per frame**. The "fixed" part is O(touched accounts): every
frame touches ~800 of the 1000 accounts (18.6k entity leaf hashes / 23 frames),
and for each touched account the hub validates the peer frame, applies on a
draft overlay, computes the account state root (2–3×: validation, commit,
proposal), builds+signs the next outbound frame (frame hanko + dispute Hanko),
seals the shell, rehashes the entity leaf, and later persists it.

So throughput grows with inputs-per-account-per-frame (that is why 3/s per user
beats 1/s), and 1000 tps with 1000 users at 1 tx/s means ~1000 account-frames
per second ≈ 1 ms each ≈ one full core. **That is exactly the work that must
be parallelised; nothing else on the main thread is big enough.**

## 2. What was done (14 commits, `15383eb34..e12de5c42`)

Protocol-neutral unless stated.

- Wire-fit slow start (×1.15 cap per frame) removed; first attempt predicted from
  the last certified wire/tx byte ratio; the measured loop stays the authority.
- Batch ECDSA recover on a Bun worker pool (`core/protocol/crypto/crypto-pool.ts`,
  `core/entity/consensus/proposal/hanko/prime-hankos.ts`): inbound frame/dispute Hankos
  signatures are recovered by bytes (97-byte records, transferable) for the fitted
  tx prefix, warming the codec memo; verifiers unchanged. Main-thread recovers
  21k → 46 per 10k payments. Pool is Bun-only at runtime, fails closed to the
  synchronous path on worker error/close.
- Envelope ECDSA (`sourceSignature`) dropped on keyed direct sessions (session MAC
  already binds the peer); sealed-box relay delivery still signs/verifies.
- **Wire format**: entity_inputs payload = MessagePack plaintext → raw ciphertext
  bytes in the MessagePack ws envelope (no JSON, no base64). 12.4 → 8.4 KB/envelope.
- Encode-once: certified frame txs (commitment projection and raw) canonical-encoded
  once per frame and reused by wire fit, frame hash, wire estimate, storage
  validation (`rememberCanonicalArrayEncoding`, frozen arrays).
- Storage: live replica meta commits to the certified head instead of the frame
  body; storage trusts frames this process certified (WeakSet mark); raw chunk
  rows for >10 KB values; WAL frame record canonicalized once. `storage.encode`
  600 → 326 MB per 12k payments.
- Entity state root: one fold of live shells per frame (no forked snapshot),
  per-field entity-leaf memo by value identity, cached radix path slots, native
  one-shot sha256 (0.65 → 0.25 µs).
- Account state: untouched collections keep the committed wrapper (no empty
  folds, identity memos keep hitting), leaf encoded once, sealed subtrees not
  re-walked, shallow shells (frames/txs shared, not deep-cloned), lazy nodeChanges,
  memoized durable jurisdiction stack, memoized profile descriptor hash.
- Deleted: per-input `validateEntityReplica` walk, settlement self-asserts on own
  txs, JSON size check of own frame, separate infra-context byte budget and
  halve-on-error loop, migration map scan, verified-hanko memo layer, alias/wrapper
  modules, redundant clones of certified links and committed frames.
- Hub no longer halts on a rejected inbound direct input (`f3e23a214`).

## 3. What is left on one thread (each ≤5%, diminishing)

| item | est. gain | notes |
|---|---|---|
| manifest signatures → worker by bytes | ~1 s / 12k | `signProposalManifest` is a sync `Promise.all`; ship (digest, signer) records like the recover pool; keys live in the worker |
| HTLC onion decrypt → worker | ~0.8 s | `decryptInboundEnvelopeUncached` is pure (ciphertext, AAD, key); prime like hankos |
| dispute Hanko hash via ethers `solidityPacked` | ~0.4 s | hand ABI encoder like `core/hanko/abi.ts` |
| ACK re-execution of own txs | ~0.7 s | proposal runs txs with `isValidation=true`, ACK with `false`; effects are produced at ACK. Not a deletion: requires validation-mode semantics change. Guard script forbids a "pending-proposal replica stash". Skipped. |
| consensus preimage: canonical JSON text → binary | ~1–1.5 s | 100 call sites + golden hashes; protocol change (all hashes). Owner wants it; gain is small |
| entity root only at checkpoint | ~0.25 ms/payment | protocol change: `frame.stateRoot` per entity frame is what validators compare |
| `frameHanko` on every account frame | 2 sign + 2 recover + 1.4 KB per frame | owner: keep for now (jBatch must stay hanko-signed); presence doubles as draft/certified phase marker in ~10 places |

Sum ≈ 10–15% → ~450–480 live. **Not 1000.**

## 4. Parallel design (shards) — the only path to 1000 on one hub

### 4.1 Principle
A worker **owns** the `AccountReplica`s of its shard across frames. Nothing is
structured-cloned per call (that was measured slower). Main thread owns the
Entity state (orderbook, htlc routes, crontab, cross-J, the accounts radix tree
of **leaf hashes only**) and the frame sequence.

Shard key: first nibble(s) of the counterparty entityId → K shards → W workers
(W = cores − 2 on the hub box; K ≥ W). Opt-in per process (`XLN_HUB_ACCOUNT_WORKERS=N`);
user runtimes keep the in-process path. Off ⇒ byte-identical behaviour.

### 4.2 Per-frame protocol (main ↔ shard)
1. Main selects the frame txs (wire fit) and groups `accountInput` txs by shard.
2. Main → shard: `{frameHeight, frameTimestamp, entityContext (htlc prepared
   entries for that shard's accounts), inputs: AccountInput[] (msgpack bytes)}`.
3. Shard applies each input exactly as `applyAccountConsensusInput` does today,
   proposes the next outbound frame, signs frame + dispute Hankos (keys derived in
   the worker from the runtime seed), seals the shell.
4. Shard → main (bytes): per touched account `{counterpartyId, leafHash
   (computeEntityAccountValueHash), summary}` + `candidateEffects`/`AccountOutput`s
   (these are already plain data) + committed account frames for history
   (msgpack) + hashesToSign entries (so main's manifest is unchanged) + events.
5. Main folds leaf hashes into the accounts radix tree (needs a
   `PersistentEntityAccountMap` variant keyed by leaf hash, not by replica), runs
   the rest of the frame (orderbook, htlc routes, crontab) and certifies the Entity
   frame. The entity frame bytes/hash are identical to the unsharded path by
   construction (same inputs, same outputs, same leaf hashes, same order).

### 4.3 Ordering
Inputs for one account are applied in frame order by its shard. Intra-frame
cross-account effects exist: an inbound HTLC lock's forward outcome is an
output for ANOTHER account (`materializeForwardOutcome`), swap fills touch both
sides. Today these are produced inside the same frame via `proposableAccounts`
and `proposePendingAccountFrames` (`application.ts:799`). Minimal deterministic
scheme: **rounds** — run shards on the frame's external inputs; collect
cross-account outputs; route them to their shards; repeat until no new outputs
(bounded by the HTLC hop count, in practice 2 rounds). Round order is
deterministic (canonical worklist order). *(Alternative: defer cross-account
outputs to the next frame — changes latency and frame contents; not preferred.)*

### 4.4 Reads of Account state from Entity logic — the real blocker
`grep -rn "accounts.get(\|getEntityAccountForWrite(" core/entity` = **113 sites in
~40 modules** (orderbook queue/cancels/helpers, payments settle/lending/swap
requests, htlc payment-admission + forward capacity, cross-J, dispute, j-batch,
rebalance scheduler, board Hanko refresh, j-events). Each either:
- needs a **summary** (capacity per token = deltas/credit/holds; pendingFrame
  height; proofHeader; mempool length) → the shard returns it after every frame
  and main keeps a `Map<counterpartyId, AccountSummary>`; or
- **mutates** the replica (`getForWrite`) → that logic must move into the shard as
  a typed command (e.g. `orderbook fill → swap_resolve tx for account X`), or the
  mutation must be expressed as an AccountInput routed to the shard.

This classification has NOT been done. It is the first task (§6.1). Until it is,
I am **not confident** the shard cut is clean; the 113 sites are why a previous
attempt (`core/account/worker/pool.ts`, unused) stalled.

### 4.5 Snapshots / nodeChanges (owner's question)
WAL frames persist inputs only; materialized Account trees are written at
checkpoints (`storage.materializePeriodFrames`, and full snapshots at
`storage.snapshotPeriodFrames`) via
`projectAccountTreeChanges(next, previous)` (`core/storage/schema/account-graph-codec.ts:126`),
i.e. `nodeChangesSince` between the replica at the previous checkpoint and now.
With shards this is **on demand at checkpoint, not per frame**: the shard keeps a
reference to each account's replica as of the last checkpoint (persistent
structures make that free), and on `checkpoint(height)` returns the encoded
rows (`puts/dels` bytes) for its dirty accounts. Restore loads rows into the
shard that owns the key range. No per-frame node traffic.

### 4.6 Determinism rules
- Shard on/off must produce identical entity frames: same tx order, same
  outputs order (canonical worklist by counterparty id), same leaf hashes, same
  hashesToSign order (sorted by hash, already).
- Replay (`replay-hub-recording.ts`) must run with shards **off** and reproduce
  the recorded frames; that is the determinism oracle.
- No wall clock in shards; frame timestamp comes from main.
- Rejections: a shard returns typed rejections; main applies the same
  `rejectAccountInput` path so ledger/incident bytes match.

### 4.7 Expected result
Account work (≈1 ms per account-frame) spread over W workers; main keeps
~0.3 ms/payment (selection, wire fit, entity frame, storage, dispatch). With
W=8: hub ≈ 1000–1500 tps *(unverified)*. Storage (0.44 ms/payment) becomes the
next wall; then dispatch.

## 5. Alternatives to consider before building shards
- **Multiple hub entities** (H1/H2/H3 already exist in the stand; users can be
  spread): aggregate ≈ 3 × 400 without any new code. The owner's stated goal is
  one hub first.
- **Bigger frames per account**: per-account fixed cost amortises; nothing to
  change on the hub, only offered load shape.

## 6. Task list for the next agent (in order)
1. Classify the 113 `accounts.get/getForWrite` sites: summary-read / shard-command /
   must-stay. Output: table in this file.
2. `AccountSummary` type + producer in the account machine (after each commit)
   + consumer adapters for summary-read sites.
3. Leaf-hash-only `PersistentEntityAccountMap` for the main thread (values are
   `{leafHash, summary}`), with the same radix layout so the entity root is
   byte-identical.
4. Shard worker: owns replicas; message codec (msgpack bytes); apply/propose/sign;
   rounds; checkpoint rows on demand; restore.
5. Feature flag + equivalence test: run a recorded 1000-user payments frame set
   with shards off and on, assert identical entity frame hashes.
6. Then the §3 leftovers (manifest sign offload, onion decrypt offload, dispute Hanko hash
   codec), binary preimage, cross-J load harness (same pair as same-J swaps, see
   `core/scripts/operations/hlt/cross/worker-cross.ts` and the mixed generator's
   unmatched-tail bug).

## 7. Commands
```bash
# live payments (authoritative): report at $D/hlt-payment-load-report.json
XLN_HLT_USERS=1000 XLN_HLT_DURATION_S=10 XLN_HLT_RATE_PER_USER=1 XLN_HLT_MIX=0:1 \
XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_SMOKE=1 XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE=payments \
XLN_LOCAL_PROD_SMOKE_DIR=/tmp/x XLN_RUNTIME_OP_COUNTERS=1 XLN_RUNTIME_OP_COUNTERS_DIR=/tmp/x/op-counters \
bun core/scripts/operations/production/local-prod-smoke.ts
# swaps: XLN_HLT_MIX=1:0 XLN_LOCAL_PROD_SMOKE_SWAP_LOAD_MODE=same → production-swap-load-report.json
# hub cpu profile: add XLN_HUB_ENGINE_ARGS_H1="--cpu-prof --cpu-prof-dir=/tmp/prof"
# op-counter call sites: XLN_RUNTIME_OP_CALLSITES=1
# recording + replay:
XLN_HLT_USERS=1000 ... XLN_LOCAL_PROD_SMOKE_DIR=/tmp/xr bun core/scripts/operations/hlt/build-chains.ts
bun core/scripts/operations/hlt/replay/replay-hub-recording.ts --recording /tmp/xr/hlt-hub-recording.json --mode max
```
Never set `XLN_LOCAL_PROD_SMOKE_PORT_BASE`. Do not edit tracked files while a
run is in progress (the lanes import source at spawn; a half-edited file fails
the run). Baseline test failures on clean main exist (~98 across entity/account/
storage/payments/protocol/network); always diff against `git stash` before
blaming a change.
