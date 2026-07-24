# xln mainnet TODO

This is the only live TODO/NEXT file and the active blocker list for deploying
code trusted with real funds. It contains launch work only, ordered from
fastest proof/fix to the hardest external gate. Completed work is deleted;
long-term work belongs in `docs/roadmap.md`, and permanent rules belong in
`docs/mainnet-engineering-principles.md`.

## 0. Complete production-health coverage — P0, open

- [ ] Route every remaining frontend, orchestrator and J-machine fatal through
  the durable incident registry. Add one explicit producer/sink coverage matrix
  so a newly introduced fatal boundary cannot bypass the registry.
- [ ] Prove a managed child replacement at an external-I/O boundary cannot
  duplicate remote dispatch or J-submit.
## 1. Commit-boundary correctness — P0, approval required

- [ ] Reject Entity-frame timestamp regression before transaction application.
  Deadline admission uses the monotonic Entity/J clock. A late bilateral
  Account frame may retain its signed timestamp, but cannot make expired
  HTLC/pull evidence valid because acceptance never uses that timestamp as the
  receiver's clock.

## 2. Runtime-owned financial planning — P0, open

- [ ] Finish one immutable Runtime swap-command plan containing canonical
  capacity, quantization and target-account preparation. Commit target setup
  before dispatching cross-J M1; UI only renders/submits the exact plan bytes
  and planner failure produces zero financial transactions. Canonical capacity
  reads and exact credit without the former 10,000-token floor are complete.

## 3. Ingress and contract boundedness — P0/P1, partly approval required

- [ ] Integrate `main`'s canonical per-operation best-effort J-batch execution
  together with byte-for-byte binding of every submitted object to its sealed
  `encodedBatch`, chain/depository/nonce domain and hash before BrowserVM or RPC
  mutation. Preserve this candidate's contract P0 hardening, regenerate the
  single ABI/artifact/typechain set, and rerun the real adapter regressions.
  This consensus/contract merge requires owner approval.
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

## 4. Transport and secret persistence — P0/P1, approval required

- [ ] Derive AEAD keys from X25519 with domain-separated HKDF-SHA256 and bind
  protocol/from/to/type/source-frame/message-id as AAD. Replace Base64 with one
  binary wire atomically, reject low-order/shared-zero keys, keep strict
  signed-profile key authority, and reject duplicate authenticated session
  sequence/message IDs through one bounded replay window before dispatch; no
  legacy codec.
- [ ] Mutually authenticate the direct hello challenge, both Runtime IDs and
  the responder encryption key. Add authenticated session-key rotation and
  prove recorded traffic cannot be decrypted after later compromise of the
  static Runtime key.
- [ ] Enforce WebSocket backpressure and per-Runtime byte/message rate limits
  from one typed limit source shared by WS, Runtime ingress and Entity frames.
  Replace 250 ms bootstrap polling overrides with authenticated initial sync,
  relay push updates, a monotonic cursor, exact lookup on cache miss and bounded
  30–60 second reconciliation.
- [ ] Stop persisting a full replay Runtime-machine projection in every WAL
  frame. Store deterministic ingress, roots, frontier/outbox changes and
  bounded checkpoints; prove crash/replay/import parity and WAL reduction.
- [ ] Store each bilateral watch seed once in an encrypted Runtime secret
  namespace and reference it from Account materialization. Prove backup,
  restore and dispute recovery before removing plaintext duplication.

## 5. Crash, corruption and load evidence — P1, open

- [ ] Profile the production bootstrap and growing-hub frame path locally.
  Remove only measured full scans/clones/duplicate crypto; publish deterministic
  1/1,000-tx and growing-hub median/p95/MAD budgets from a clean Bun cache.
  Measure the duplicate Account wake scan, per-frame verified-profile clone and
  repeated cross-J preview application; replace them only with dirty/versioned
  indexes or structural preflight proven byte-identical. The first indexes are
  one ephemeral `proposableAccountKeys` queue and a canonical
  `(entityId, signerId) → replicaKey` map rebuilt on restore/import. Record
  `frameCloneMs`, cloned replica/account/profile counts, estimated cloned bytes
  and cross-J preview clone time. A frame touching one account must not scale
  linearly when untouched accounts grow from 10,000 to 100,000.
- [ ] Replace case-insensitive Account scans and repeated signer/pair lookups
  with canonical direct indexes, including exact cross-J replica/account
  descriptors; then introduce Runtime→Entity→Account COW only behind
  byte-identical differential roots and measured clone counters.

## 6. Public Ethereum and TRON proof — P0 release blocker, open

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

## 7. Immutable mainnet release pipeline — P0 release blocker, open

- [ ] Extend the candidate binding already enforced for isolated E2E run/shard
  manifests to unit, contract, scenario, recovery, public-chain and final
  release evidence. One `candidateId = gitHead + codeHash + gateConfigHash`
  must identify the entire immutable evidence set.
- [ ] Run L1/L2 first, then exactly one unchanged-candidate unified full E2E,
  `bun run check`, `bun run gate:release` and the uninterrupted
  `bun run gate:mainnet`. Every financial browser E2E must use the same
  mandatory console/page/request fatal guard; eventual DOM success cannot hide
  a browser or Runtime error.
- [ ] Complete an independent contract/runtime audit on the immutable SHA with
  conservation, fuzz, dispute and recovery evidence plus public deployment
  receipts and explicit known limitations.
- [ ] Merge only the proven SHA into clean `main`, tag, publish, deploy the
  production servers/contracts, verify live health and books, and upload the
  unified story videos plus API evidence.
