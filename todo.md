# xln active TODO

This is the only live TODO/NEXT file. It contains active work only. Completed
work is deleted; git history and immutable release evidence preserve the proof.
Audit claims enter this file only after reproduction against the current tree.

## Non-negotiable architecture

- [ ] Keep one implementation, persisted format and version. No legacy paths,
  migrations, fallback readers/writers or parallel financial formulas before
  mainnet; testnet resets onto the current format.
- [ ] Keep RJEA pure and deterministic. Runtime enforces policy, WAL commit
  precedes dispatch, errors fail loud, all finance uses canonical bigint
  reducers, and frozen core changes require owner approval.
- [ ] Keep Runtime signers derived immediately from the seed. Entity threshold
  multisigners are the custody boundary; do not move Runtime policy into HSM.
- [ ] Keep recovery trust order: operator backups, watchtowers, then hubs. Peer
  state is neither authority nor an automatic recovery dependency.

## Current release — native TRON USDT

- [ ] Finish the native TRON adapter gate: protobuf signing/broadcast, live
  energy-based fee limits, SolidityNode finality, authenticated complete
  receipts and exact EVM/base58/hex41 address parity.
- [ ] Preserve the fresh Nile deployment with official USDT at internal token
  ID 1 and immutable 28,800-block dispute delay. Re-run read plus real
  approve/deposit after the candidate SHA is frozen.
- [ ] Prove Ethereum↔TRON cross-j terms, route hashes, block-time deadlines and
  both dispute paths. A second live-chain deployment needs funded Sepolia
  authority; local two-chain execution remains mandatory regardless.
- [ ] Run L1/L2, `bun run check`, release gates and one immutable unified E2E.
  Commit, merge to clean `main`, remove the worktree/branch, push, tag, publish
  and deploy the testnet release only from that green SHA.
- [ ] Upload the final unified-run videos and evidence to the server after the
  release; verify four story videos plus API evidence. Upload is not a code gate.

## P0 — commit-boundary correctness

- [ ] Make Account frame history, security incidents and storage invalidations
  returned `CandidateExecution.effects`. Publish them only with the exact
  committed Entity hash. A rejected proposal/replay must leave all external
  Env projections byte-identical.
- [ ] Construct unknown Account genesis ephemerally and insert it into
  `state.accounts` only after an accepted height-1 bilateral frame. A rejected
  input must not consume one of the bounded Account slots.
- [ ] Keep the live replay tripwire permanent: after proposer and receiver
  commit, incremental and cold Account roots must equal the signed
  `frame.accountStateRoot`.

## P1 — hot-hub execution, low-hanging first

- [ ] Use the exact `directPayment` next-hop Account returned by the handler;
  remove the post-payment scan of every Account.
- [ ] Canonicalize Account map keys once at validation/insertion and use direct
  `accounts.get(id)`; remove every case-insensitive linear lookup.
- [ ] Validate each same-J resting pair once per matching pass, mirroring the
  existing cross-J asserted-pair set.
- [ ] Replace the repeatedly copied/filtered/sorted `proposableAccounts` Set
  with one deterministic stable queue. Delete production `deterministicState`
  after proving its callers use only `newState`.
- [ ] Drive same-J/cross-J matching, fill/cancel drains and TTL work only from
  dirty pair/admission/deadline indexes. Use deterministic crontab/min-heap
  deadlines rather than scanning all persisted books each Entity frame.

## P1 — draft execution architecture

- [ ] Introduce `CandidateExecution = state + effects + dirtyIndexes` and an
  Entity `FrameDraft`: immutable base with copy-on-write only for touched
  Accounts, books and maps. Differential tests must prove byte-identical roots.
- [ ] Keep Account happy-path sequential optimistic application on one clone.
  Replace the invalid-tx fallback's growing per-tx clones with a transition
  journal/AccountDraft; commit once or replay once with the root tripwire.
- [ ] Cache the Entity Account-section commitment and update it from touched
  Account keys. Preserve the existing incremental Account/book commitments.
- [ ] Extract evaluation, certification, commit and effects from the large
  consensus facades only after byte-identical dual-run evidence. No big-bang
  rewrite and no second production implementation.

## P1 — cross-j locality

- [ ] Move sibling inspection out of the Entity reducer into a Runtime
  `CrossJCoordinator` that emits one immutable certified cohort manifest.
  Entity replay receives only local state plus that certified input.
- [ ] Split immutable hash-bound `CrossJTerms` from versioned `CrossJProgress`;
  update progress only through one pure `reduceCrossJ(event)`.
- [ ] Keep one two-leg opening envelope and synchronous scratch validation on
  both Runtimes. Preserve manual whole-envelope retry and no opening receipt.

## Storage and recovery

- [ ] Extend real SIGKILL coverage through split mutation, collapse, delete,
  restore-clear and raw `0x7e` orphan/root assertions.
- [ ] Add snapshot/epoch/rotation/prune and corruption matrices for oversized
  typed Account/Entity/Book values and exact 9,999/10,000-byte boundaries.
- [ ] Show linked manifest→branch→leaf physical paths, bytes and checksums in
  the browser DB reader with laptop/mobile/wide screenshot E2E.
- [ ] In one future fresh schema, replace proof-history CAS families and
  generic oversized Entity/Book paging with typed mutable binary owner paths;
  hashes remain integrity checks, never key routes.
- [ ] Add deterministic SimNetwork/SimStorage seeded delay/reorder/drop/
  partial-write/kill tests; preserve every red seed.

## Test system and QA

- [ ] Split pure/storage/BrowserVM/stress gates and record per-file duration.
  Replace fixed waits with state predicates and reproduce one target 10x before
  calling it flaky.
- [ ] Make QA verdicts bind one `candidateId = gitHead + codeHash +
  gateConfigHash`; record unit/contract/scenario/release results and comparable
  median/p95/MAD baselines.
- [ ] Add a failure-fingerprint inbox with exact narrow rerun commands; use a
  small run index/event stream and lazy evidence instead of full polling.
- [ ] Keep shareable history projections separate from exact recovery bundles
  so a viewer does not disclose the complete financial Runtime state.

## Next release — company formation, IPO and takeover

- [ ] Add E2E company registration that creates the Entity and all seed-derived
  signers in one user action: founder 1-of-1 → directors 2-of-3, with exact
  board/Hanko and restart persistence checks.
- [ ] Mint distinct native control and dividend classes. Company treasury owns
  the initial supply; listing hub receives no ownership or custody.
- [ ] Implement IPO as treasury collateral in the company's Account with the
  selected hub. The company acts as maker, the hub creates the trading pair,
  and buyers trade USDT/UTC for control or dividend shares immediately.
- [ ] Implement buyback as an ordinary treasury bid for its own shares through
  the same hub. Dividend cash payouts remain out of scope for this release.
- [ ] Implement control takeover: a collateralized holder proving >50% control
  can schedule board replacement after at least seven days. Activation must
  preserve pre-existing proof validity until the delay expires, then reject old
  board signatures without stopping trading or buybacks.
- [ ] Cover founder issuance, partial sale, multiple buyers, failed 50%, valid
  >50%, delayed rotation, old-signature rejection, restart/replay and continued
  market operation in one screenshot-driven TradFi-style flow.

## Mainnet acceptance

- [ ] No artificial deposit cap. UI and docs state testnet risk; protocol
  safety comes from invariant proofs, not a hidden amount branch.
- [ ] Run `bun run gate:mainnet` on the exact immutable release SHA; never
  substitute a narrower test profile for mainnet acceptance.
- [ ] Complete external contract/runtime audit on an immutable SHA, full
  conservation/fuzz/dispute/recovery gates, Ethereum and TRON testnets, release
  rehearsal and production monitoring before enabling real funds.

## External audit handoff

- [ ] Publish the immutable SHA, reproducible gate commands, contract addresses,
  deployment receipts and scoped known limitations for independent review.
