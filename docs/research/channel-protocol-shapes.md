# Channel and provable-account protocol shapes versus the xln Account

Reviewed 2026-10-07 against `d6a0845fd` (read-only; no core, contract or test
changes). Owner question: compare Interledger's Bilateral Transfer Protocol
(BTP) with `core/account`, decide which is simpler and which is better, and take
the best simplicity and reliability ideas from other channel and
provable-account designs.

Two sibling studies exist. [btp-and-simplicity.md](btp-and-simplicity.md)
answers the BTP verdict per guarantee and ranks eight ideas, several with TLA
evidence. [provable-account-mechanisms.md](provable-account-mechanisms.md)
compares mechanisms feature by feature. This document adds what neither has:
twelve designs side by side on wire shape, signatures, ordering and conflict
rule, the places where xln is measurably heavier than every peer, and the two
protocol forks those places suggest, written to the level of hash layout and
adversarial check so the owner can decide.

## Verdict in five lines

1. **BTP is not a competitor.** Four packets, no signed state, no dispute, no
   collateral; request IDs "are not idempotent" by its own text. The
   per-guarantee comparison is in the sibling study; the equivalence mapping is
   in section 1 here.
2. **xln's state model is already the modern one:** symmetric state, unified
   strictly-increasing nonce, no revocation or penalty (the eltoo, Nitro, Perun
   and Nitrolite shape), multi-token in one account, LEFT-wins collisions.
3. **xln is measurably heavier than every peer in two places** that the
   literature solves more cheaply: two Hankos per side per frame (Raiden signs
   one object for both off-chain and on-chain use) and reconnect recovery by
   inference (Lightning declares state in `channel_reestablish`).
4. **One thing from BTP is worth taking:** a peer-visible reject with a
   retry/final class. Today a receiver reject sends nothing back and the
   proposer keeps its pending frame; that is the sibling study's idea 3 and the
   evidence is confirmed in section 1.
5. **Both forks need the owner.** They change the signed hash layout or add a
   wire message; neither is an autonomous change.

## Measured sizes

Sizes are `wc -l` over non-test TypeScript or Solidity at `d6a0845fd`.

| Surface                                                              |  Lines | Files |
| -------------------------------------------------------------------- | -----: | ----: |
| `core/account` (all)                                                 | 18,735 |   113 |
| `core/account/consensus`                                             |  5,938 |    28 |
| `core/account/consensus/index.ts`                                    |  1,280 |     1 |
| `core/account/consensus/incoming/replay.ts` (duplicate/stale inputs) |    525 |     1 |
| `core/account/consensus/incoming/ack-commit.ts`                      |    466 |     1 |
| `core/account/consensus/incoming/preflight.ts`                       |    359 |     1 |
| `core/account/consensus/incoming/collision.ts`                       |    196 |     1 |
| `core/account/consensus/dispute/hanko.ts`                            |    189 |     1 |
| `core/account/tx/handlers` (21 AccountTx kinds)                      |  3,831 |    19 |
| `core/network` + `core/runtime/delivery` (transport, outbox)         | 14,990 |     — |
| `jurisdictions/contracts/Account.sol`                                |  1,826 |     1 |
| `jurisdictions/contracts/Depository.sol`                             |  1,025 |     1 |
| Rust files on the Account path (`rscore`, parity engine)             | 11,534 |     — |
| Account test files under `core/__tests__`                            |      — |    70 |

Wire and type counts in xln: 4 routed `AccountInput` kinds (`ack`,
`ack_frame`, `dispute`, `board_hanko_refresh`), 2 local kinds (`enqueue`,
`external_finality`), 21 `AccountTx` types, 23 typed input rejection codes,
8 typed tx rejection kinds, up to 4 Hankos per committed frame.

## Protocol shapes side by side

| Design                      | Wire objects per update                                                                         | Signatures per update                                | Ordering primitive                                                    | What the chain verifies                                                      | Concurrent-update rule                  |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| BTP/2.0                     | Message, Transfer, Response, Error                                                              | 0                                                    | 4-byte request ID, "not idempotent"                                   | nothing                                                                      | none                                    |
| ILPv4                       | Prepare, Fulfill, Reject                                                                        | 0                                                    | expiry + SHA-256 condition                                            | nothing                                                                      | none                                    |
| XRPL PayChan                | 1 off-ledger claim, 3 ledger txs                                                                | 1 (payer)                                            | cumulative amount, largest wins                                       | (channel, amount)                                                            | unidirectional                          |
| Raiden                      | 1 balance proof per direction                                                                   | 1 per direction                                      | per-direction nonce, cumulative `transferred_amount`                  | `balance_hash`, nonce, `additional_hash`                                     | directions independent                  |
| Celer                       | 1 simplex state per direction                                                                   | 2 per direction                                      | `seq_num`, cumulative `transfer_to_peer`                              | simplex state + pay registry                                                 | directions independent                  |
| Lightning BOLT2             | about 30 message types                                                                          | 1 commitment sig + 1 revocation per side             | commitment number, revocation secrets                                 | asymmetric commitment txs, penalty                                           | four-state pending model                |
| eltoo / LN-Symmetry         | update + settlement tx                                                                          | 1 per side                                           | monotone locktime, latest wins                                        | update tx                                                                    | symmetric                               |
| Nitro                       | 1 State (fixed + variable part)                                                                 | 1 per state, turn based                              | `turnNum`, support proof                                              | state hash, outcome                                                          | turn taking                             |
| Perun                       | `State{ID, Version, App, Allocation, Data, IsFinal}`                                            | all parties                                          | `Version`                                                             | state                                                                        | all-party agreement                     |
| Nitrolite / ERC-7824 (2026) | 1 State per transition                                                                          | `UserSig` + `NodeSig`                                | `Version` exactly +1                                                  | state, ledger invariant                                                      | user ↔ node only                        |
| Hydra                       | ReqTx, ReqSn, AckSn                                                                             | multisig per snapshot                                | snapshot `s = ŝ + 1`, leader rotation                                 | snapshot, contest                                                            | leader proposes                         |
| xln Account                 | `ack_frame` (ACK + proposal fused), `ack`, `dispute`, `board_hanko_refresh`; 21 tx kinds inside | 2 to 4 Hankos per frame (frame + dispute, each side) | height + `prevFrameHash` off-chain; unified non-sequential nonce on J | `ProofBody` (offdeltas, tokenIds, transformers, response seconds, watchSeed) | LEFT wins same height, RIGHT rolls back |

## 1. BTP concepts mapped onto xln

BTP in its own words (RFC-23, fetched 2026-10-07): four packet types; a
request ID that is "a random 4-byte value" and "not idempotent"; `Transfer.amount`
is "additional value of this settlement state ... in a unit that was agreed
out-of-band"; after `Response` "balances MUST have been updated"; "sub-protocols
include optional functionality like ledger metadata, balance, automated
settlement, and dispute resolution"; "if an unexpected BTP packet is received,
no response should be sent". ILPv4 (RFC-27) explains why it can stay small:
connectors "may refuse to process further ILP packets if an account balance
goes too low" and "will most likely NOT use conditional channels".

| BTP                                | xln                                                                                                      | Note                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Transfer` + `Response`            | `ack_frame` proposal + `ack`                                                                             | one delivery acknowledges the previous frame and proposes the next, the 2024 `Channel.ts` flush shape |
| request ID                         | frame height + `prevFrameHash` + `stateHash`                                                             | ordering is part of the signed state, not a transport nonce                                           |
| per-connection `auth_token`        | Hanko on every frame and ACK, envelope party/domain check on every input                                 | per-message authority, survives transport changes                                                     |
| "not idempotent"                   | duplicate proposal rebuilds the exact cached ACK; conflicting bytes at the same height are a loud reject | `incoming/replay.ts`                                                                                  |
| `Error` with final/temporary codes | typed per-tx reject, local only                                                                          | see below                                                                                             |
| no response to unexpected packets  | a rejected input produces no response                                                                    | same loop guard                                                                                       |
| balance updated "out of band"      | collateral, credit, debt and disputes in `Depository.sol` / `Account.sol`                                | the part BTP does not have                                                                            |

**Simpler:** BTP, by about 100×. **Better for carrying value:** xln; a BTP
balance is a trusted ledger entry that no third party can enforce. The
sibling study's per-guarantee table is the canonical statement of this.

**The one BTP property xln lacks, confirmed at `d6a0845fd`:** a receiver
reject is silent. `rejectAccountInput` returns no response; the only recorded
trace is `shadow.rejectedFrameEvidence` written by the dispute handler. On the
proposer side `rejectUnavailableProposal` returns "Waiting for ACK on pending
frame" while `pendingFrame` is set, and the scheduler's `watchdog` hook logs
`hook.unimplemented`. So after a reject the proposer re-emits the same bytes on
the next peer-ready edge and otherwise waits; the sibling study found dispute
to be the only exit. BTP's `Error` with a temporary/final class is the
smallest fix; it is idea 3 there and is not re-specified here.

Status note: Rafiki documents ILP-over-HTTP for connector peering. I did not
find an explicit deprecation notice for BTP, so I do not claim one.

## 2. One mechanism per design that makes it simple

- **XRPL PayChan.** A claim is (channel ID, cumulative amount); the largest
  claim wins and there is no nonce. Monotone quantities need no ordering. Not
  transferable to xln: Δ is a net bilateral quantity and locks/swaps are not
  monotone, so a nonce stays.
- **Raiden.** One balance proof per direction. The signed message is
  `(chain_id, type, channel_id, balance_hash, nonce, additional_hash)` where
  `balance_hash = keccak(transferred_amount, locked_amount, locksroot)` and
  `additional_hash` commits the whole off-chain message. One signature serves
  both the peer and the contract; the contract never replays transfers.
  **This is the idea xln can borrow** (section 3A).
- **Celer.** Same cumulative idea with a pending-pay linked list and a global
  pay registry. Both peers sign each simplex state. Nothing new over Raiden.
- **Lightning.** The most complex: asymmetric commitment transactions,
  revocation secrets, penalties, a four-state pending model and about 30
  messages. Its one excellent reconnect design is `channel_reestablish`: each
  side states `next_commitment_number` and `next_revocation_number`, the peer
  "MUST retransmit `commitment_signed` if it was sent after the last
  `revoke_and_ack` received", and irreconcilable numbers mean "MUST send an
  `error` and fail the channel". Recovery is declared, not inferred
  (section 3B).
- **eltoo / LN-Symmetry.** Symmetric state, monotone update number, latest
  state wins, no revocation. xln's unified nonce ("Jumps like 10 → 15 → 234 are
  valid. Replays fail automatically", `Account.sol` header) is this model.
- **Nitro.** One `State` with a fixed part (participants, nonce, app,
  challengeDuration) and a variable part (outcome, appData, turnNum, isFinal).
  Turn taking removes concurrency. `checkpoint()` advances the on-chain
  `turnNumRecord` without a challenge. xln's LEFT-wins rule is simpler than
  turn taking for two parties; checkpoint is an optional idea (section 5).
- **Perun.** Six fields in `State`; `IsFinal` lets a final state settle without
  a window. xln has the equivalent happy path as a signed `Settlement` with
  nonce; the `cooperative` finalize flag was deliberately removed
  (`prepareDisputeFinalization` reverts on it). No gap.
- **Nitrolite / ERC-7824, published February 2026.** Version "MUST start at 1
  ... each new version to be exactly the previous version plus one", both sign
  every state (`UserSig`, `NodeSig`), ledger invariant
  `UserAllocation + NodeAllocation == UserNetFlow + NodeNetFlow`, intents
  OPERATE / CLOSE / DEPOSIT / WITHDRAW. The newest design converges on the xln
  shape. It is narrower: user-to-node only, one token per ledger, no credit.
- **Hydra.** Leader for snapshot `n` is `(n - 1) mod parties`; a ReqSn must
  satisfy `s = ŝ + 1`; transactions are applied to a "seen" ledger immediately
  and confirmed by the multisigned snapshot. Full validation before AckSn is
  the lesson of their 2.4.1 advisory; xln's draft replay before ACK already
  matches. The optimistic seen-ledger is a throughput idea, not a simplicity
  one, and is out of scope here.

## 3. Where xln is heavier than every peer, and the cheaper design

### 3A. Two Hankos per side per frame

This is the sibling study's idea 5 at design depth.

Evidence at `d6a0845fd`:

- `buildIncomingFrameReturnPayload` emits `hashesToSign` of type `accountFrame`
  and, when `proofChanged`, a second of type `dispute`.
- `AccountReplica` carries five local and five counterparty dispute-witness
  fields (`currentDisputeProofHanko`, `...Nonce`, `...ProposerIsLeft`,
  `...BodyHash`, `currentDisputeHash` and their `counterparty*` twins) next to
  `currentFrameHanko` / `counterpartyFrameHanko`.
- `dispute/hanko.ts` (189 lines) validates the witness, and
  `getDisputeHankoRequirementError` has six rejection branches; `selectAckDisputeHanko`,
  `reusableCertifiedAckHanko` and `proofHeader.nextProofNonce` decide when the
  second signature is needed. The standalone `dispute` input kind exists to
  refresh that witness without a frame.

Why it exists: the frame Hanko signs `stateHash`, a digest over the radix-Merkle
`accountStateRoot`, which the J cannot recompute cheaply, while the J executes
`ProofBody` (offdeltas, tokenIds, transformers). So the ProofBody gets its own
hash, its own nonce and its own Hanko.

Raiden's answer: sign one message that contains the chain-relevant fields and
an `additional_hash` over everything else. Translated to xln:

```text
H = disputeProofHankoHash(acctKey, nonce, proposerIsLeft, proofBodyHash, watchSeed, frameHash)
```

The frame already determines `proofBodyHash` ("ProofBody is never cached. It is
a deterministic projection of the frozen AccountState"), so adding it as a frame
field costs 32 bytes and no new authority. One Hanko per side per frame then
serves off-chain consensus and the J proof. What it would delete: the ten
dispute-witness replica fields collapse to two, `proofChanged` /
`nextProofNonce` / `reusableCertifiedAckHanko` go away, the `dispute` input kind
is only needed after a J-consumed nonce (an empty frame does the same), and
Hanko verifications per committed frame halve.

Open protocol questions that make this an owner fork, not an autonomous change:

1. Nonce space. Today frames have heights and dispute proofs have nonces; C2R
   settlements also set the stored nonce. If `nonce = height`, a
   `settle_transition` committed in frame `h` and the dispute proof of frame `h`
   share a nonce in different hash domains; `Account.sol` must accept that one
   of them consumes the nonce and the other is then stale. Adversarial check:
   settlement at `h` lands, counterparty starts a dispute with the proof of `h`,
   must be rejected (not strictly greater) and the proof of `h + 1` must still
   win.
2. Board-rotation grace is per signature; unchanged, but the single Hanko now
   covers the frame, so a retired board's seven-day grace applies to frames too.
   Adversarial check: retired quorum signs a frame at a high height against a
   counterparty; the counterparty's newer frame must still counter.
3. Rust parity: the authority engine hashes frames in `rscore`; a new frame
   field changes `AccountFrame::hash` on both engines in one step.

Smallest next production check before deciding: count `verifyHanko` calls per
committed frame on the HLT path using the existing `account.verify.frameHanko`
perf phase, so the gain is a measured number rather than "halves".

### 3B. Reconnect recovery by inference instead of declaration

Evidence: `incoming/replay.ts` recovers a lost ACK from three sources in order
(`reusePendingDuplicateAck`, `reuseLastOutboundDuplicateAck`,
`rebuildDuplicateCommittedAckFrame`), each re-verifying a Hanko; `preflight.ts`
and `collision.ts` add stale-frame and same-height branches. The proposal side
is re-emitted on the peer-ready edge by `propose_accounts_now` from retained
`pendingAccountInput` bytes ("never a silent transport resend").

Lightning's design: a two-field `channel_reestablish` on every connection, after
which each side knows exactly which of {pending commitment, pending revocation,
nothing} to resend, and a contradiction fails the channel loudly.

Translated to xln: an `account_reestablish` sent on the delivery-ready edge
carrying `{currentHeight, currentFrameHash, pendingHeight?}`. The receiver then
re-emits either the retained pending proposal or the retained
`lastOutboundAckFrame`, or nothing. Contradictory heights map to the existing
`disputeRequired` disposition. This is live-replica coordination data, so it
stays outside the state root as AGENTS.md requires.

What it would delete: two of the three duplicate-ACK sources (keep
`lastOutboundAckFrame` until the next committed frame as the single ACK
replay source), and the stale-frame inference in `preflight.ts`. Keep the
idempotent "same height, same bytes" check as a cheap guard. The sibling
study rates Vector-style one-round sync as already equivalent in guarantee;
this proposal does not change the guarantee, it replaces inferred recovery
with declared recovery so that fewer branches carry it.

### 3C. Envelope re-validation on every input

Every routed `AccountInput` repeats `domain`, `disputeConfig` and `watchSeed`,
and `getAccountInputEnvelopeError` checks them before signature work. ILPv4
puts no source address in the packet; identity comes from the authenticated
link. In xln the Hanko already binds the frame hash, which commits the state
root, which commits those three fields, so the repeat is defense in depth and a
cheap typed reject before signature verification. Optional; measure bytes per
input before touching it.

### 3D. Intrinsic complexity: rotating signers

`board_hanko_refresh`, `boardHankoRefreshMigration`,
`counterpartyBoardHankoRefresh` and the seven-day retired-board grace have no
peer equivalent because no peer protocol lets a channel participant change its
key set mid-channel; Nitro would treat it as a new channel. xln chose account
continuity across board rotation. Keep; not a candidate.

### 3E. Product scope, not protocol waste

Twenty-one `AccountTx` kinds against one to three in every peer: peers push
applications outside the channel (Nitro app contracts, Perun apps, Celer
conditions), xln embeds payments, swaps, lending, rebalance, cross-J pulls and
settlement in the account. That is the RCPAN thesis. The catalog is an
exhaustive type-checked list (`tx/catalog.ts`), which is the right shape.

## 4. Where xln is already simpler than its peers

- **Collision rule.** Each side may propose once per height; valid LEFT wins,
  RIGHT restores its transactions once (`collision.ts`). Lightning needs the
  four-state pending model, Nitro turn taking, Hydra leader rotation. Keep the
  rule. The two durable memory fields behind it (`rollbackCount`,
  `lastRollbackFrameHash`) are the sibling study's idea 1, backed by its TLA
  run; nothing here depends on them.
- **No revocation, no penalty, one nonce.** The eltoo class, implemented.
- **State on chain, transitions off chain.** The J executes `ProofBody` and
  never replays transactions; peers replay the frame and check the state root
  before ACK. Same split as Hydra's seen-ledger plus snapshot.
- **Reject never halts.** One bad transaction evicts one transaction.
- **One account, many tokens.** Up to 128 token rows with collateral and credit
  per row; Raiden, XRPL and Nitrolite are one token per channel or ledger.

## 5. Ideas ranked by simplicity gained per risk

| Rank | Source                                 | Idea                                                                         | Gain                                                                                      | Decision needed                                           |
| ---- | -------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1    | Raiden `additional_hash`               | one Hanko per side per frame, frame carries `proofBodyHash` (sibling idea 5) | deletes ten replica fields, the `proofChanged` machinery and half the Hanko verifications | owner fork (nonce space, grace, Rust hash)                |
| 2    | Lightning `channel_reestablish`        | `account_reestablish` on the peer-ready edge                                 | deletes two of three duplicate-ACK sources and stale-frame inference                      | owner fork (new live-replica wire message)                |
| 3    | BTP `Error` T/F classes                | peer-visible reject notice (sibling idea 3)                                  | ends the silent-reject wait; dispute stops being the only exit                            | unsigned notice is low risk; signed NACK is an owner fork |
| 4    | Nitro `checkpoint`                     | both-signed on-chain nonce bump without a dispute window                     | cheap stale-state kill for towers                                                         | optional; only if tower economics show a need             |
| 5    | ILPv4 "no source in packet"            | trim repeated envelope fields after session binding                          | bytes per input                                                                           | optional; measure first                                   |
| —    | XRPL, Raiden, Celer cumulative amounts | per-direction monotone balances                                              | none                                                                                      | do not take: Δ with conditional clauses needs ordering    |
| —    | Hydra seen ledger                      | pipeline transactions ahead of the snapshot                                  | throughput, not simplicity                                                                | out of scope                                              |

## 6. Limits of this review

- Read-only. No tests were run; line counts are `wc -l`; signature counts come
  from reading `hashesToSign` construction, not from a trace.
- ERC-7824 struct text was not retrievable (four URLs returned 404); the
  Nitrolite claims above come from the docs.yellow.org state-and-ledger page.
  BOLT2 and the Raiden contract were read from `master` on 2026-10-07, not from
  the revisions pinned in the earlier mechanism study.
- Not measured: Hanko verifications per committed frame, bytes per `AccountInput`,
  and the share of `replay.ts` branches hit in production. Each candidate above
  names its measurement.
- The fused ACK + proposal, LEFT-wins collision and unified nonce are owner
  decisions already in canonical code; this document does not reopen them.

## Sources

- [BTP/2.0, RFC-23](https://interledger.org/developers/rfcs/bilateral-transfer-protocol/)
- [ILPv4, RFC-27](https://github.com/interledger/rfcs/blob/master/0027-interledger-protocol-4/0027-interledger-protocol-4.md)
- [Raiden TokenNetwork.sol](https://github.com/raiden-network/raiden-contracts/blob/master/raiden_contracts/data/source/raiden/TokenNetwork.sol)
- [Celer cChannel entity.proto](https://github.com/celer-network/cChannel-eth/blob/master/contracts/lib/data/proto/entity.proto)
- [Lightning BOLT2](https://github.com/lightning/bolts/blob/master/02-peer-protocol.md)
- [LN-Symmetry draft](https://github.com/instagibbs/bolts/blob/eltoo_draft/XX-eltoo-transactions.md)
- [Nitro states and channels](https://docs.statechannels.org/protocol-tutorial/0010-states-channels/), [ForceMove.sol](https://github.com/statechannels/go-nitro/blob/main/packages/nitro-protocol/contracts/ForceMove.sol)
- [go-perun channel/state.go](https://github.com/hyperledger-labs/go-perun/blob/main/channel/state.go)
- [Nitrolite state and ledger model](https://docs.yellow.org/nitrolite/protocol/state-and-ledger-model), [ERC-7824 thread](https://ethereum-magicians.org/t/erc-7824-state-channels-framework/22566)
- [Hydra HeadLogic.hs](https://github.com/cardano-scaling/hydra/blob/master/hydra-node/src/Hydra/HeadLogic.hs)
- [XRPL PaymentChannelClaim](https://xrpl.org/docs/references/protocol/transactions/types/paymentchannelclaim)
- xln: [Account.sol](../../jurisdictions/contracts/Account.sol), [consensus/index.ts](../../core/account/consensus/index.ts), [incoming/replay.ts](../../core/account/consensus/incoming/replay.ts), [dispute/hanko.ts](../../core/account/consensus/dispute/hanko.ts), [proposal/admission.ts](../../core/account/consensus/proposal/admission.ts), [RCPAN invariant](../core/12_invariant.md), [consensus invariants](../consensus-invariants.md)
