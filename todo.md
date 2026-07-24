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
  gates fail on unexplained open incidents.
- [ ] Reproduce the production bootstrap locally with the production storage
  byte threshold, then run beyond the first epoch rotation with H1/H2/H3/MM
  healthy, no stale frames, no orphan processes and no growing empty-chain
  disk workload.
- [ ] Prove through Runtime state, public API and browser E2E that every
  supported same-J pair exposes exactly 10 bids and 10 asks. Prove cross-J
  full fill closes both legs and removes the user order; partial GTC remains
  open until later fill or explicit close.

## 1. Commit-boundary correctness

- [ ] Reject Entity-frame timestamp regression before transaction application.
  Deadline admission uses the monotonic Entity/J clock. A late bilateral
  Account frame may retain its signed timestamp, but cannot make expired
  HTLC/pull evidence valid because acceptance never uses that timestamp as the
  receiver's clock.

## 2. Runtime-owned financial planning

- [ ] Move swap capacity, quantization and auto-credit preparation into one
  Runtime pure planner. UI renders the immutable plan and submits its exact
  bytes; planner failure produces zero financial transactions.
- [ ] Remove the arbitrary 10,000-token cross-J credit floor. A new account gets
  only the exact required inbound credit, visibly separated from swap amount.

## 3. Transport and secret persistence

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

## 4. Crash, corruption and load evidence

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

## 5. Public Ethereum and TRON proof

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

## 6. Immutable mainnet release pipeline

- [ ] Bind every result to
  `candidateId = gitHead + codeHash + gateConfigHash`; store unit, contract,
  scenario, browser, recovery, public-chain and release evidence together.
- [ ] Run L1/L2 first, then exactly one unchanged-candidate unified full E2E,
  `bun run check`, `bun run gate:release` and the uninterrupted
  `bun run gate:mainnet`.
- [ ] Complete an independent contract/runtime audit on the immutable SHA with
  conservation, fuzz, dispute and recovery evidence plus public deployment
  receipts and explicit known limitations.
- [ ] Merge only the proven SHA into clean `main`, tag, publish, deploy the
  production servers/contracts, verify live health and books, and upload the
  unified story videos plus API evidence.
