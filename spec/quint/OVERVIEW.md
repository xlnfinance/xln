# The Quint spec in one read

What the spec says, layer by layer: the state, the data that flows between layers, the state machines, the properties and the
mutants that prove each property bites. The files are the spec; this page is the map. Choices for unclear points are in
[QUESTIONS.md](QUESTIONS.md) (A = Account, C = chain, S = settlement, E = Entity, J = batch, R = Runtime); status is in
[PROGRESS.md](PROGRESS.md).

## The layers and what crosses between them

```
   user / peers ─▶ Runtime ─▶ Entity ─▶ Account (two replicas) ─▶ signed proofs ─┐
                     │ ▲         │ ▲                                              │
     durable log ◀───┘ │         │ └── J events (read LAG late, in order) ◀────┐   │
                       │         ▼                                              │   ▼
                       └── batches (signed, nonce n) ─▶ J: Depository ─────────┴── disputes, settlements, payouts
```

| layer | module | owns | consumes | produces |
|---|---|---|---|---|
| Account | `account_core`, `account` | the bilateral state (offdelta, credit limits, HTLC locks), the frame protocol between two replicas | transactions from its Entity, the peer's proposals and acks | committed bodies; a co-signed dispute proof per frame (no baseline of the next epoch: the chain's implicit proof stands in, C13) |
| Entity | `entity` | what one Entity does with its Accounts: routing, deadlines, escalation, freezing, commands | peer frames, acks, J events, signed commands, the tick | Account transactions, J ops (dispute start, counter, reveal, finalize) |
| J, one Account | `chain` | the dispute game and the payout of one Account on the Depository | J ops | reserves, collateral, epoch, debt, the secret registry |
| J, settlement | `settle` | the off-chain epoch lifecycle over the chain (cooperative update with fold, the first signed proof of an epoch at stored + 2) | frames, the chain's view | the first proof of the next epoch |
| J, batch | `jbatch` | how the Entity's ops reach the chain: strict nonce, atomic revert, urgent ops, the skip event of a dead dispute op | ops | landed batches, `DisputeOpSkipped` |
| Runtime | `runtime` | frame order, the idle gate, durability, J watching, the halt list | inputs from all sources | frames that are durable before they leave |

Nothing crosses a layer boundary except what the table says. A chain fact reaches an Account only as a J event, `LAG` ticks after
it happened (R-J1). A signed proof reaches the chain only through a batch.

## The numbers the layers share

`LAG` (a J transaction is included, and a J event read, within this many ticks), `REACT = 2 * LAG` (read it, then get the answer
included), the two dispute windows `>= 2 * MIN_WINDOW > REACT` (C11), `HOP >= REACT` between a hub's inbound and onward deadlines
(E3), `ESC >= LAG` (escalate that long before a deadline). `params_test.qnt` pins them across the modules; a change in one layer
fails there.

## Account (`account_core.qnt`, `account.qnt`)

State per replica: `height`, `pnonce` (the proof nonce of the last committed frame, its own counter: N1, A13), the committed `tip` Body, `status` (`Open | Proposed(f) | Received(f)`), a mempool, `attempt` (as a proposer: the refusals handled on this head), `mark` (as a receiver: the highest attempt it refused on this head), `hi` (the highest proof nonce it knows signed, its own and the peer's it has seen) and `sig` (the highest rank it signed), and `sigLocks` and `kept` (the locks in the proofs it signed, and the notices that wait for them: R-SIGNED-IS-LIVE). A Body is
`{offdelta, limitLeft, limitRight, locks}`; a lock is a slot with payer, amount, hashlock, deadline.

State machine of a replica: `Open` -- propose -> `Proposed(f)` -- ack -> `Open` (committed); `Open` -- peer's proposal -> `Received(f)`
-- own ack -> `Open`; a collision (both propose at one height): Left keeps its frame, Right rolls back to its mempool and applies
Left's (A1). A lost proposal or ack is recovered by resend. A refusal is a value, never a halt.
R-FRAME-REFUSAL (A16, A17): a frame that is next in line and that the receiver cannot apply is answered with a refusal `{frame, index of the first refused tx, fault, mark}`; the proposer rolls its pending, unacked frame back
(a refusal for any other frame is ignored), sends every tx again at the next attempt when the fault is retryable (`not_expired`, `deadline_too_far`, within a budget of `MAX_ATTEMPT`) and otherwise drops the named tx with notice, then proposes
the rest. A frame carries its `attempt`; the receiver keeps one mark per head, the highest attempt it refused: a frame at the mark is refused again, one below it gets `stale_attempt` and the mark, one above is judged afresh; the mark is
forgotten when the head moves, so a frame the receiver refused is never taken while the head lasts (no fork when its view of J moves). A frame is signed at proof nonce `max(pnonce, hi) + 1`: above every proof either side signed in the epoch, a yielded or refused attempt included (R-PROOF-NONCE-ABOVE-SIGNED, A19); a receiver acks a frame only if its rank (`nonce * 2 + leftAuthored`) is above every proof it signed itself, else it answers `nonce_low` with its `hi` and the proposer signs again above it. A refusal or a yield does not release a lock that sits in a signed, unsuperseded proof: its notice waits (`kept`) until a frame above commits or the deadline plus the reserve has passed on the side's own clock (R-SIGNED-IS-LIVE, A20; the Entity layer has no place for it yet). A side that co-signed a settlement or a reserve-to-collateral is frozen: it proposes nothing and answers every peer frame with a retryable `frozen` refusal until the operation lands, is superseded or lapses (R-COSIGN-FREEZE, A21). A collision is won by the higher slot, and at one slot by the Left-authored frame (A19). The transition table (`applyTx`) has
six transactions: SetCredit, Pay, HtlcLock, HtlcResolve, HtlcCancel, HtlcExpire.

Time (R-CLOCK, A8): a frame's timestamp is informational; every time decision uses the deciding side's own clock. Resolve needs `now <= deadline`,
expire needs `now > deadline + CLOCK_RESERVE` (`CLOCK_RESERVE = DRIFT`), a lock's deadline is at most `now + MAX_LOCK_HORIZON + CLOCK_RESERVE` away (A9).

A Byzantine peer is part of the model: one side's key is taken at any moment and it sends frames no correct proposer would (forged state, skipped
height, expiry stamped from the future, resolve stamped in the past, stale or leaping proof nonce, a wrong ack). The honest side is checked.

Properties: `credit_holds` (RCPAN in the worst case over open clauses, stated on the outcomes by an independent oracle), `agreed` (no two committed bodies at one
height, except that with a Byzantine peer a later frame of higher rank supersedes the earlier commit, as the chain ranks them: A12), `no_equivocation`, `both_signed`, `no_bad_accept` (nothing is held for an ack that a correct receiver refuses),
`authority` (no spending the other side's funds, no self-granted credit, no early expiry), `nonce_climbs`, `no_tx_lost`, `no_orphan` (a side never holds as committed a frame its author gave up on a refusal), `signed_above_head` (no signed proof outranks the committed head), `no_release_while_signed_live` (no hold released while a signed proof holds the lock), `refusal_floor_reachable` (a refusal's signed floor is at most one above what the proposer knows), `cosign_fold_holds` (R-COSIGN-FREEZE: a side frozen by a co-signed fold keeps the head's offdelta the fold carries and has nothing in flight). 74 scenario tests, 93 mutants.

## Chain, one Account (`chain.qnt`)

State: the Account (`nonce, epoch, coll, ondelta`), money (reserves and debt per side), the dispute (starter, initial proof, windows,
counter), the secret registry, an arena of signed proofs (`nonce, epoch, leftAuthored, offdelta, clause, windows, signatures`).
Rank of a proof is `nonce * 2 + leftAuthored` (Left wins a tie).
R-IMPLICIT-BASELINE (C13): from epoch 1 a dispute may start from the implicit proof, which is in no arena slot: no signature, a body synthesized from chain state (nonce stored + 1, Right-authored,
offdelta 0, no clause, windows at the floor), settling at Delta = ondelta. A signed frame of the epoch outranks it through a counter, except a Right-authored one at stored + 1, which only ties it (a tie is a
refused counter). A deposit keeps the epoch. Counter and final windows may lengthen, never shorten. Single token: the starter's token naming is v2.

State machine: `NoDispute` -- start(proof) -> `Active` -- counter(newer proof of the starter) -> `Active` -- finalize (three paths:
timeout on the initial proof, timeout on the counter, the non-starter adopting a newer proof at once) -> `NoDispute` with the epoch
advanced (C1) and collateral emptied. A clause pays iff its secret is on the chain by its deadline (E6), and a finalize over an open
clause waits for the deadline (H1). The honest side answers within `REACT`; an absent honest side can lose and is excluded from P1.

Properties: `p1_allowed` (what settles is a proof the honest side consented to or holds as its own latest), `p1_clause` (an honest
payee that learned the secret `LAG` before the deadline is paid), `p3_conserved` (money is conserved), `nonce_monotone`,
`no_double_settle`, `debt_only_when_broke`, `debt_means_broke` (after a payout that leaves debt the debtor has nothing spendable, and holds no reserve at all when its debt queue fitted in one enforcement call), `debt_queue_sums`, `r2c_enforces_first` (a deposit enforces the older debt first, F15), and the checks that state the payout on the outcome instead of through the guard: `pay_exact` (a finalize moves each
side's worth, reserve less debt owed plus debt owed to it, by exactly its allocation), `deposit_exact`, `windows_never_shortened` (N3: windows may lengthen, never shorten, inside an epoch; over unequal windows),
`closes_on_time` (both windows run in full), `nonce_rules` (a start needs a nonce above the stored one; a finalize stores the adopted nonce or one more), `forgive_ok` (R-SETTLE-FORGIVE: a settlement forgives the head claim of each side's debt queue that is owed to the other side of the Account, and nothing else, reverts only when nothing was forgiven and a debt exists or past the id cap or on a repeated id; one token). A queued claim is owed to the other side or to a third party; enforcement pays third parties out of the reserves (`Money.out`, counted by `p3_conserved`). The `offline` flag is per dispute.
77 scenario tests, 95 mutants.

## Settlement (`settle.qnt`)

The off-chain epoch: frames are Pay or Lock; a cooperative update folds the agreed offdelta into the ondelta and opens the next epoch. There is no baseline of the next epoch to co-sign
(R-IMPLICIT-BASELINE, C13; S3 superseded): from epoch 1 the chain's implicit proof is the proof to dispute with. The Runtime's rule that goes with it: the first signed proof of a new epoch takes the
stored nonce + 2 (`FIRST_GAP`), the stored nonce read from the chain, and the epoch's own counter is gapless after it; the honest side signs and acks by that rule. Properties: `no_dead_commit`, `no_lost_pay`, `claims_conserved`, `book_enforceable`,
`hostage_free`, `first_proof_at_stored_plus_two`.
16 scenario tests, 22 mutants.

## Entity (`entity.qnt`)

A hub with two Accounts (IN: the peer pays us; OUT: we pay on), both peers adversarial. One frame is four phases over one
state: (1) inputs (peer frames and acks first, then chain events: E1), (2) hooks read the state after the input (resolve, expire, route, fail back, escalate, reveal), (3) an atomic
signed command, (4) propose one frame per Account in ascending order.

Own dispute start: `Idle -> await -> {DisputeStarted: ours is open | DisputeOpSkipped: the peer's is open and ours is skipped}` (E12).

Route per inbound slot: `Idle -> Fwd -> {Paid | Back}`; the onward lock goes to the lowest free OUT slot (E7). Rules: onward deadline = inbound - HOP; escalate `ESC` before a deadline; fail back only
when the onward lock is gone from a signed state or the deadline + LAG passed with the secret unknown; a dispute carries every known
payee secret; a dispute freezes the Account's frames.

Properties: `no_peer_halt`, `no_stranded`, `deadline_chain`, `dispute_carries_all`, `no_needless_dispute`, `no_frame_on_frozen`,
`cmd_atomic`, `credit_holds`, `route_safe` (the hub is never out of pocket), `answer_in_window`, `skip_ends_the_wait`. 23 mutants.

## J batch (`jbatch.qnt`)

State: the chain's stored nonce and reserve, the signed batches the Entity submitted (each with a nonce and a set of ops), the ops
(payment, secret reveal, dispute step). A batch lands iff its nonce is the next and no op reverts; a signed batch never expires.
Rules (J1 to J3, F1, F2, R-SPLIT): abandon an op only when it can never apply; urgent ops (dispute, reveal, hash ladder) never share a batch with payment, settlement or reserve ops (R-SPLIT); **a signed batch is final at its
nonce: never sign other content at a signed nonce, every replacement goes to a fresh one** (F1); after an abort only urgent ops go back into the draft at once, a payment, deposit or reserve move only after the abandoned batch's nonce is used and BatchFailed is read (F2). J2 (accepted): dispute ops skip instead of reverting, and the chain emits `DisputeOpSkipped(sender, counterentity, op, reason, nonce)`; the Entity abandons the op on reading it.

J5 refinement (coordinator, #54 review): a batch with a deposit leg reverts whole and never soft-fails (`dep_never_burns`); a bad counterparty signature inside a batch (a
settlement signed at an old epoch) is a soft fail; only a failure of the batch's own authorisation reverts without taking the nonce (`only_signed_land`). The cost of the first
is J6 (a stuck deposit batch holds the urgent ops behind it; a token failure in a deposit leg stays a hard revert on purpose, J6a). A deposit that cannot be signed while the token is paused is skipped, so the payments behind it still go out (J6b). The adversarial relayer sends any batch in any order (`attemptAny`) and forged batches (`forge`).

Properties: `urgent_lands`, `dropped_only_dead`, `skip_read`, `failed_read`, `no_burn`, `nonce_final`, `pay_once`, `urgent_once`, `nonce_sequential`, `reserve_sound`, `dep_never_burns`, `only_signed_land`, `cosign_alone`, `gate_respected`, `within_cap`, `no_unfunded_signed` (F14: a payment is signed only if the reserve covers it). 37 scenario tests, 34 mutants.

## Runtime (`runtime.qnt`)

State: memory, the durable copy, the inbox, the chain head, what the peer has received. One frame = apply, persist, send; a crash
can come between any two steps. Rules (R1 to R5): canonical order (peers, then chain events, then commands), idle gate, cursor moves with the frame that applies the event (every kind of event, `DisputeOpSkipped` included: R7),
durable before send, command acknowledged only when durable, a closed list of local halt causes.

Properties: `no_equivocation`, `exactly_once_j`, `acked_durable`, `canonical_frames`. 8 mutants.

## What the spec asks of the contracts

| id | request | why | evidence |
|---|---|---|---|
| C1, C2, H1, H2 | done in the fork (`contracts/`) | see plan/contracts-review.md | chain mutants |
| C11 (accepted) | each dispute window above `LAG` (the floor of 60 s meets it while a J event is read and included in under 60 s) | the honest side needs `REACT` | `window-floor-below-react` |
| J2 (accepted) | dispute ops (start, counter, finalize, reveal) skip instead of revert, and an op that already ran is a no-op | a revert takes the urgent ops of the batch with it | `contract-reverts-on-moved-dispute` |
| J5 (accepted, as built) | a batch with no dispute, reveal or hash-ladder op that fails takes its nonce, applies nothing and emits `BatchFailed`; a mixed batch still reverts whole; a failure is reported only when the self-call got at least `BATCH_GAS_FLOOR`, below it the transaction reverts and takes no nonce | F1 forbids signing other content at an open nonce, so a batch that reverts holds every batch above it | `payment-revert-keeps-the-nonce` |
| E6 | a secret revealed before the deadline pays at finalize even when the dispute starts later | the Entity relies on it | pinned on the real contracts (#47) |

## What is not in it yet

Several tokens and swaps (v2), the order book, lending, boards (v2), the joint state of the hub's two Accounts and the chain (the
Account-to-chain link is checked as a predicate over Bodies, C12), an offline Entity. See PROGRESS.md "Next".
