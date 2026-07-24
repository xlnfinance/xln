# xln mainnet TODO

This is the only live TODO/NEXT file and the active blocker list for deploying
code trusted with real funds. It contains launch work only, ordered from
fastest proof/fix to the hardest external gate. Completed work is deleted;
long-term work belongs in `docs/roadmap.md`, and permanent rules belong in
`docs/mainnet-engineering-principles.md`.

## 0. Restore and prove production health

- [ ] Make `/api/debug/incidents` the mandatory first diagnostic query:
  browser, frontend, Runtime, managed-child, orchestrator and J-machine errors
  must enter one redacted stream, group by root-cause fingerprint, survive
  gossip flood/restart, and support unread/acknowledged/resolved state. Release
  gates fail on unexplained open incidents. All money controls must derive
  readiness from the same Runtime lifecycle gate and perform zero enqueue while
  halted, quiescing or restoring.
- [ ] Reproduce the production bootstrap locally with the production storage
  byte threshold, then run beyond the first epoch rotation with H1/H2/H3/MM
  healthy, no stale frames, no orphan processes and no growing empty-chain
  disk workload.
- [ ] Extend the exact-depth browser matrix across every supported same-J pair:
  each must render exactly the configured 10 bids and 10 asks, with no hidden
  missing or surplus offers. Keep the existing authoritative health/API
  equality assertions as the precondition for every browser check.

## 1. Commit-boundary correctness

- [ ] Reject Entity-frame timestamp regression before transaction application.
  Deadline admission uses the monotonic Entity/J clock. A late bilateral
  Account frame may retain its signed timestamp, but cannot make expired
  HTLC/pull evidence valid because acceptance never uses that timestamp as the
  receiver's clock.

## 2. Runtime-owned financial planning

- [ ] Finish one immutable Runtime swap-command plan containing canonical
  capacity, quantization and target-account preparation. Commit target setup
  before dispatching cross-J M1; UI only renders/submits the exact plan bytes
  and planner failure produces zero financial transactions. Canonical capacity
  reads and exact credit without the former 10,000-token floor are complete.

## 3. Ingress and contract boundedness

- [ ] Bind every submitted J-batch object byte-for-byte to its sealed
  `encodedBatch`, chain/depository/nonce domain and hash before either BrowserVM
  or RPC mutation. Integrate the completed `ai/jbatch-binding` change only
  after owner approval and rerun the real adapter regressions.
- [ ] Classify remote Entity-input failures by typed cause. Only malformed
  unauthenticated ingress may be quarantined; storage errors, state-machine
  contradictions and local bugs must halt. Prove every class through the real
  `applyMergedEntityInputs` path.
- [ ] Replace the unbounded `_forgiveDebtsBetweenEntities` queue scan with an
  indexed or bounded-continuation structure. Prove exact debt conservation and
  bounded gas with adversarial creditor ordering.
- [ ] Remove the remaining proven pre-mainnet compatibility ABI/state:
  migrate V1 settlement `diffsToOps` and `position.xlnomy`, then delete unused
  contract `resolveEntityId` and ineffective `hashToBlock/cleanSecret`. Use one
  schema/ABI change with no legacy decoder or fallback. `Env.browserVM` is
  currently live infrastructure, not dead code; do not delete it as an audit
  shortcut.

## 4. Transport and secret persistence

- [ ] Derive AEAD keys from X25519 with domain-separated HKDF-SHA256 and bind
  protocol/from/to/type/source-frame/message-id as AAD. Replace Base64 with one
  binary wire atomically; no legacy codec.
- [ ] Add authenticated session-key rotation and prove recorded traffic cannot
  be decrypted after later compromise of the static Runtime key.
- [ ] Enforce WebSocket backpressure and per-Runtime byte/message rate limits
  from one typed limit source shared by WS, Runtime ingress and Entity frames.
- [ ] Stop persisting a full replay Runtime-machine projection in every WAL
  frame. Store deterministic ingress, roots, frontier/outbox changes and
  bounded checkpoints; prove crash/replay/import parity and WAL reduction.
- [ ] Store each bilateral watch seed once in an encrypted Runtime secret
  namespace and reference it from Account materialization. Prove backup,
  restore and dispute recovery before removing plaintext duplication.

## 5. Crash, corruption and load evidence

- [ ] Pass real SIGKILL recovery through split mutation, collapse, delete,
  restore-clear and raw orphan/root assertions.
- [ ] Pass snapshot/epoch/rotation/prune/corruption matrices for oversized
  typed Account/Entity/Book values and exact 9,999/10,000-byte boundaries.
- [ ] Add deterministic SimNetwork/SimStorage delay/reorder/drop/partial-write/
  kill tests and retain every failing seed.
- [ ] Profile the production bootstrap and growing-hub frame path locally.
  Remove only measured full scans/clones/duplicate crypto; publish deterministic
  1/1,000-tx and growing-hub median/p95/MAD budgets from a clean Bun cache.
- [ ] Replace case-insensitive Account scans and repeated signer/pair lookups
  with canonical direct indexes; then introduce Runtime→Entity→Account COW only
  behind byte-identical differential roots and measured clone counters.

## 6. Public Ethereum and TRON proof

- [ ] Finish the native TRON adapter: protobuf transaction signing/broadcast,
  live energy fee limits, SolidityNode finality, complete authenticated
  receipts and exact EVM/base58/hex41 address parity.
- [ ] Freeze a candidate SHA, verify the existing Nile Depository with official
  USDT token ID 1 and immutable 28,800-block dispute delay, then perform real
  approve, deposit, cooperative withdrawal and both dispute paths.
- [ ] Deploy the same candidate to Ethereum Sepolia and prove deposit,
  settlement, cooperative withdrawal and both dispute paths against public RPC
  receipts.
- [ ] Prove Ethereum-Sepolia ↔ TRON-Nile cross-J full fill, partial GTC, manual
  close, restart/replay, route hashes and chain-domain deadlines.
- [ ] Define and independently review the TRON authority-proof domain. TRON
  headers commit transactions rather than Ethereum receipt tries; never
  synthesize an Ethereum MPT proof or trust one RPC witness.

## 7. Immutable mainnet release pipeline

- [ ] Extend the candidate binding already enforced for isolated E2E run/shard
  manifests to unit, contract, scenario, recovery, public-chain and final
  release evidence. One `candidateId = gitHead + codeHash + gateConfigHash`
  must identify the entire immutable evidence set.
- [ ] Run L1/L2 first, then exactly one unchanged-candidate unified full E2E,
  `bun run check`, `bun run gate:release` and the uninterrupted
  `bun run gate:mainnet`.
- [ ] Complete an independent contract/runtime audit on the immutable SHA with
  conservation, fuzz, dispute and recovery evidence plus public deployment
  receipts and explicit known limitations.
- [ ] Merge only the proven SHA into clean `main`, tag, publish, deploy the
  production servers/contracts, verify live health and books, and upload the
  unified story videos plus API evidence.
