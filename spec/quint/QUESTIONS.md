# Unclear points and the choices made

Format: **id**, the point, the options, **choice**, the source it rests on. An entry is closed when the coordinator
decides. Until then the spec follows the choice written here.

## Account layer (`account.qnt`)

**A1. Two frames at one height (collision).**
Options: (a) Left wins, Right rolls back and takes Left's; (b) both give way and retry with a back-off; (c) the lower
frame hash wins.
Choice: (a). Left keeps its frame and ignores Right's, Right discards its own frame, puts its txs back at the front
of its mempool and holds Left's frame. Source: R-A1, `Types.sol` equal-nonce rule (Left wins), `xln.ts:10644`.
Consequence stated: Right has already signed a proof at that nonce for its own frame, so one signer holds two
signatures at one nonce. They are different branches (`authorIsLeft` is in the signed hash), and the contract's
tie-break picks Left's. P4b is therefore per (signer, nonce, branch), not per (signer, nonce).

**A2. Liveness under message loss (Q-A2).**
Options: (a) the proposer resends its frame, the receiver answers a repeat idempotently; (b) each proposal carries the
previous ack so nothing is ever lost; (c) time-based retransmission in the spec.
Choice: (a). `resend` is enabled while a frame is in flight; a receiver that already committed that frame answers
with the same ack, **in any replica state** (R-REACK, coordinator 09-30, from the Account comparison D-AC-1). This model first re-acked only while
the receiver was Open: a receiver that had already proposed its own next frame refused the repeat, and one lost ack left both sides stuck (Right
`Proposed(1)`, Left `Proposed(2)`, each refusing the other's frame). The Arrival spec re-acks whatever the state and its checker proves liveness;
this model checks safety only, so the gap went unseen. Now `repeatOfLast` is checked before the status match; test `lostAckWhileHoldingOwnFrameTest`,
mutant `reack-open-only`. When to resend is Runtime policy, not protocol. Source: `design/account-model.md` P4/P5, no og
retransmission exists (`collision.ts:117`).

**A3. Rejection of a peer frame (Q-A3).**
Options: (a) refuse silently and count it; (b) send a reject message; (c) treat as dispute evidence and freeze.
Choice: (a) for this layer. A frame is all-or-nothing: the first tx that does not apply refuses the whole frame, the
receiver's state is untouched, and no message is sent. Two honest sides never refuse each other's frames in this
model, so the case is only exercised by stale and duplicate frames. **Superseded in part by R-FRAME-REFUSAL (A16, A17): a frame that is next in line and cannot be applied is now answered with a refusal, because the silent
version left the proposer wedged; the silent refusal stays for a frame that is not next in line.** The Byzantine-peer case is now modelled in `account.qnt`
(a peer that proposes forged state, skipped heights, stamps from the future or the past, wrong acks): every such frame is
refused and counted, the honest state does not move, and no side ever freezes on it. Option (c) stays available to the Entity
(the refused frame plus the peer's earlier signature are evidence), but nothing in the Account depends on it. Source: R-X1, Q-E2, Q-A3.

**A4. Frame shape (Q-A4).**
Options: (a) propose-then-ack as separate messages; (b) each proposal carries the counter-signature of the last.
Choice: (a). Piggybacking an ack on the next proposal (og's `ack_frame`) is a transport optimisation with no state
effect, so it is not modelled. Source: `xln.ts:9556`.

**A5. Who signs when. CLOSED by R-CLOCK (A8) and the Byzantine model.**
Choice: the proposer signs the frame and the resulting dispute proof when it proposes; the receiver signs both when it
acks. A side commits a frame when the counterparty's signature over it exists. So an un-acked proposal already
gives the counterparty a signed proof (design/account-model.md section 2, "signing a proposal is consent to it").
The review asked what keeps a Byzantine proposer from making the honest side sign a state it never agreed to. Answer: the honest
side signs only what it replayed itself (A6), on its own clock (A8), and `account.qnt` now runs a Byzantine side (`byz`) that
proposes anything: `both_signed`, `no_bad_accept` and `authority` check the honest side (its committed state was signed by it, and
came from frames that applied on its own tip). Mutants `accept-forged-state`, `accept-height-skip`, `ack-skips-proof-match` and `receiver-judges-by-the-frame-stamp` test that.

**A6. No parent hash in the frame. SUPERSEDED by R-PARENT (coordinator 09-30, D-AC-7): a frame names its parent and the receiver refuses a frame whose parent is not its head.**
What stays true of the text below: the receiver also replays the txs on its own tip and compares the claimed body. What changed: `Frame.parent` (the id of
the frame it extends, the stand-in for the wire's parent hash), `acceptable` requires `f.parent == r.lastFid`, the oracle `wellFormed` states it again, a
Byzantine frame of kind 6 names a parent that is not the head, mutant `accept-wrong-parent`, test `wrongParentIsRefusedTest`. Reason: the Arrival spec and xln.ts
(`prevFrameHash`, hashed into `stateHash`) both link frames by hash; two histories that reach the same body were accepted here and refused there.
Old text, kept for the record:
Options: (a) a frame names its parent by hash; (b) the receiver replays the txs on its own tip and compares the
claimed state.
Choice: (b). A frame built on a different tip either replays to a different state (refused) or to the same state
(harmless). The wire still needs a hash for framing; that is an encoding detail. Source: R-E1 discussion.

**A7. Same-view admission (Q-E1).**
Choice: yes, one view. A local tx is admitted against the state the side is planning (committed state, or the frame in
flight / held) plus everything already queued, so a tx that could never apply never enters the mempool. At
proposal time the proposer still cuts any tx that no longer applies (the peer's frame may have changed the state).
**R-NOTICE (coordinator 09-30, D-AC-5):** such a tx is refused with notice, never dropped silently. `keepValid` returns `dropped`; `propose` appends them to
`Replica.refused` (the notice the Entity reads), and `reviseMempool` does the same for a mempool whose txs can no longer apply, so a dead tx does not sit in the
mempool for ever (before this round a lone dead tx made `canPropose` false for good, unreported). Property `no_tx_lost`: every admitted tx is in a frame its side
committed as author, in its mempool, in its frame in flight, or refused with notice. Mutants `propose-drops-silently`, `dead-tx-stays`, `revise-loses-the-notice`.
Tests `deadTxIsRefusedWithNoticeTest`, `deadTxBesideALiveOneIsNoticedAtProposeTest`. Both guards stay, in this order (R-ADMIT): admission first, re-validation at propose.
The Entity's own mempool (`entity.qnt` `proposeOn`) still counts drops in a ghost and does not hold a notice list: not changed here.
Source: Q-E1 recommendation, B-X3.

**A8. Clocks and deadlines (Q-X2, Q-P1). R-CLOCK (coordinator, 2026-09-29, from the first review) replaces the earlier rule.**
Old rule (dropped): every deadline rule read the frame timestamp, and a frame had to be within `TOLERANCE` of the receiver's clock and
not before the previous one. Found by the review: the proposer chooses that stamp, so a Byzantine proposer could stamp a resolve
"before the deadline" long after it, or stamp an expiry early, and the receiver had no independent time.
R-CLOCK: **a frame's timestamp is informational**. Every time decision uses the deciding side's own clock, plus a reserve where the two
clocks' difference could hurt the other side. `CLOCK_RESERVE = DRIFT` (the clocks never differ by more than `DRIFT`, an assumption the
protocol cannot enforce, QUESTIONS Q-X2).
- Resolve needs `now <= deadline` (own clock, no reserve: a payee may take its money until its own clock says the deadline passed).
- Expire needs `now > deadline + CLOCK_RESERVE` (a payer waits for the reserve, so it never takes back a lock whose payee still holds the
  secret on a slower clock).
- Lock admission: `deadline <= now + MAX_LOCK_HORIZON + CLOCK_RESERVE` (A9).
- A frame stamped in the past or the future is accepted (odd stamps are harmless: `oddStampsAreAcceptedTest`, `oldFrameIsAcceptedAfterAnOutageTest`);
  a resolve or expiry is refused or accepted by the receiver's own clock (`backdatedResolveIsRefusedTest`, `futureStampedExpiryIsRefusedTest`,
  `expiryWaitsForTheReceiversOwnClockTest`). The replica no longer keeps `lastTs`, so an outage cannot wedge the account.
A margin beyond the reserve is Entity policy (`HOP`, `ESC`). An expiry is a system tx the payer's Entity queues from its own clock
(`expireOne` waits for `deadline + CLOCK_RESERVE`). Boundary tests: `lockDeadlineBoundariesTest`, `resolveAtTheDeadlineSecondTest`.
Mutants: `resolve-after-deadline`, `expire-at-deadline`, `horizon-off`, `receiver-judges-by-the-frame-stamp`, `expiry-reserve-off`.
**The #57 sequence (coordinator, 2026-09-30).** A secret resolve is late only by the chain's J height, never by the co-signed frame clock; a payer's cancel and timeout keep the
frame-expiry rule plus the payer's own local expiry check; a frame's `jHeight` is claimed by its proposer and is untrusted. **R-HTLC-CLOCK (coordinator 09-30, Account comparison D-AC-2, D-AC-3) settles what this model called weaker.** `clock` is now read as each party's OWN VIEW OF THE J
HEIGHT (the `max(host.finalizedJHeight, ctx.jHeight)` door), never a wall clock and never a proposer-written field; each view lags the chain by at most LAG, so the two
differ by at most `DRIFT = LAG` (`params_test` pins `DRIFT == LAG`). With that reading the Account layer's rules ARE the decided ones: (a) a lock is live through its deadline
height, the payer accepts a resolve while its own view is `<= deadline` (`resolve-after-deadline`, `resolveAtTheDeadlineSecondTest`); (b) an expiry needs own view
`> deadline + reserve`, strict, for the proposer and the acceptor (`expire-at-deadline` and `expiry-reserve-off`: killed by `htlcExpireAndCancelTest`; the oracle `expiredEarly` states the goal for the simulator, but 1500 traces of 40 steps did not reach a lock, a drifted clock pair and an expiry together, so the scenario test is the kill), and the reserve is at least LAG (`params_test`); (c) a payee whose resolve is unacked when its view reaches `deadline - LAG` reveals on-chain: that is
`ESC >= LAG` in `entity.qnt` (escalate when `now + ESC >= deadline`). The earlier caveat, that an honest payer whose clock runs ahead can refuse an on-time resolve, is the view
lag: it costs a dispute, not funds, and the reserve is what stops the payer taking back a lock whose payee still holds the secret. Not modelled: a chain height variable
(the two views with the `DRIFT` bound stand for it), and the receiver's view as a value that can also stall. The frame's `jHeight` field is not modelled: a proposer-claimed J height would be one more
informational field, and any decision that read it would fail the way `receiver-judges-by-the-frame-stamp` does. What was missing is the sequence itself, now a test: a payer co-signs a
frame stamped 100 ahead of every clock (`byzStampedQueued`, the frame that carries the lock), it is committed (`refusals == 0`), and the payee's held reveal is proposed as usual
(`futureStampedFrameDoesNotBlockTheRevealTest`). Mutant `future-stamp-refused` (the dropped stamp-window rule) blocks it and is killed by that test. (The hub variant, one hub carrying
several such frames, is Entity-level and uses the same Account rule.)
The oracle `expiredEarly` states the goal, not the guard: no committed expiry while either clock is at or before the deadline (the payee may still resolve on its own clock). A first version of it added the reserve and
flagged a correct expiry (receiver's clock 4, payee's 3, deadline 2); simulation found it the moment the Byzantine nonce frames became reachable.
Open: the model does not prove the Runtime keeps `DRIFT` small; that is an operational assumption (NTP, refuse to sign when the
local clock looks wrong).

**A9. HTLC deadline horizon: `MAX_LOCK_HORIZON` (coordinator decision, N2, policy).**
Choice: a side refuses a lock whose deadline is more than `MAX_LOCK_HORIZON` (plus `CLOCK_RESERVE`) after its own clock (`deadline_too_far`; R-CLOCK, A8). It is
a per-side policy parameter, not a protocol constant; the contracts bound nothing here. The coordinator names the default 7 days, never
below the 24 h async window, enforced in time and in J height, at lock admission and at forward. The model has one clock: a tick is a
unit of time and of J height alike (`LAG` counts J inclusion in ticks), so the two bounds are one number here, and the second check would
only repeat the first; a real implementation keeps both (a lock may carry a J height deadline the chain reads). At forward the hub's own
onward lock goes through the same `applyTx`; its deadline is the inbound one less `HOP`, so it is inside the horizon whenever the
inbound lock was (`farDeadlineIsRefusedTest`; `forwardKeepsTheMarginTest` forwards a lock at the horizon); mutant `horizon-off`.

**A10. HTLC resolution rights.**
Choice: only the payee can resolve (reveal) or cancel a lock; anyone can expire it, after the deadline. A secret is
represented by an integer and a hashlock by `hashOf(secret)`; who knows which secret is not part of the Account (it
comes from routing) and is modelled as unconstrained, which over-approximates honest behaviour. Source:
`account-model.md` section 4.

**A15. R-ONE-LOCK-PER-HASH (coordinator 09-30).** An Account holds at most one open clause per hashlock, whoever the payer. `applyTx` refuses a second `HtlcLock` on an open hashlock with `lock_exists` (the slot id still addresses the lock). og refuses it (xln.ts 7457-7458); this model allowed it until now. `oneLockPerHashlockTest` pins it (second lock by either payer refused, a different hashlock still fits the other slot); mutant `duplicate-hashlock-allowed`.

**A16. R-FRAME-REFUSAL: the receiver refuses a frame it cannot apply, and the proposer handles the refusal (coordinator 10-01, Review A of PR 82 F2; the kernel's rounds 2 and 3, `review/handoff-a4.md`).**
The gap: a deadline that passes while a frame is in flight makes the receiver unable to apply it (an expiry its own view says is not yet expired, a lock whose deadline is not after its view). Until now the receiver
refused and counted (A3) and nothing answered, so the proposer kept its pending frame for ever, and a stuck Left frame also blocks Right (Left keeps its own frame on a collision and ignores Right's). The spec had
no clock-driven wedge check because no property is a liveness one; `refusedFrameIsRetriedAtTheNextAttemptTest` is the schedule, and mutant `proposer-ignores-refusal` the wedge.
Choice (as decided): a frame that is next in line (`inLine`: from the peer, the receiver's next height, parent, proof nonce) and that the receiver cannot apply is answered with a `Refusal`
`{fid, index, fault, mark}`: the frame by its id (the wire's hash), the index of the first tx it refused, a fault tag (the `applyTx` reason; `bad_state` for a frame whose txs apply but not to the state it claims), and
the mark (A17). The refusal is a message in a set `nacks`, with the same free redelivery and loss as proposals and acks (A14; `loseNack`). A frame that is not next in line (stale, from the future, a wrong parent or nonce, a
second frame while one is held) is refused as before, counted and silent: nothing honest sends one. The proposer (`onRefusal`) acts only on a refusal that names the frame it has in flight, unacked, with an index that names a tx
of it; any other refusal (a frame already committed, rolled back, never sent) changes nothing. Then it rolls the frame back (Proposed to Open, the frame's txs ahead of the mempool) and:
a RETRYABLE fault (`retryable`: `not_expired`, `deadline_too_far`: the ones that pass as the peer's view moves) sends EVERY tx of the frame back for another attempt, with no notice, while its attempt count is below `MAX_ATTEMPT`
(2 here, stands for 8); any other fault, or a retryable one with the budget spent, drops the named tx WITH NOTICE (`refused`, `no_tx_lost`: the payer is released) and keeps the rest. `propose` then sends the rest as an ordinary frame.
A refusal for a committed frame is ignored (`refusalForACommittedFrameIsIgnoredTest`, from a peer that acked and then refused: only a Byzantine one; `byzNack` is that peer, any fault, index and mark). Left-wins still decides simultaneous
proposals: a Right that refuses Left's frame in a collision keeps its own frame in flight (`rightKeepsItsFrameWhenItRefusesLeftsTest`); a Left holding its own frame still ignores Right's (the kernel answers a declined frame before
keeping its own; here the Left case is unchanged, and the fuzz of the two will show the difference).
Tests: `refusedFrameIsRetriedAtTheNextAttemptTest` (a deadline passes in flight: refusal, the same tx at attempt 1 after the receiver's clock moves, both commit), `nonRetryableFaultDropsTheNamedTxTest` (index 1 named, dropped
with notice, the credit tx before it goes out again), `refusalForACommittedFrameIsIgnoredTest`, `retryBudgetIsSpentThenTheTxIsDroppedTest`, `refusalHandlingTest` (the rule by case as a function), `byzantineRefusalOnlyCostsTheNamedTxTest`.
Mutants: `proposer-ignores-refusal`, `retryable-fault-drops-the-tx`, `retry-budget-unbounded`, `refusal-for-committed-frame-rolls-back`, `refusal-drops-the-first-tx`, `refusal-drops-without-notice`, `right-rolls-back-when-it-refuses`, and `accept-own-frame` (rule C: a replica refuses a frame whose
author is itself; it had no mutant, and no delivery offers one, so `ownFrameIsNeverTakenTest` calls `acceptable` and `onPropose` directly). Not modelled: spacing the retries (Runtime policy), the refusal's signature (the refusal names the frame by id here; the wire names it by a hash the receiver can compute without applying it, R-FRAME-HASH-SIGNED).

**A17. The attempt number, the receiver's mark and the fork (R-FRAME-REFUSAL, kernel round 2 and 3).**
A frame carries `attempt` (the refusals its proposer has handled on this head), part of its content: a retry is a different frame. The receiver keeps ONE mark per head (`Replica.mark`): the highest attempt it refused, with the index
and the fault. A frame next in line is judged by it before anything else: at the mark, it is refused again with the refusal that set the mark; below it, a refusal with fault `stale_attempt`, index 0 and the mark (every refused
frame is answered: mutant `stale-attempt-silent`); above it, or with no mark, it is judged afresh and a refusal raises the mark. The mark is forgotten whenever the head moves (`commit`: mutant `mark-kept-across-head-moves`), and the
proposer's attempt with it. The proposer's next attempt is max(own, mark) + 1 (`attempt-ignores-the-mark`); a stale answer costs no tx (`stale-attempt-drops-the-tx`).
Why: (1) a refused frame at attempt 0 also refuses any other frame at attempt 0 on that head (a forged one must not get a genuine one refused for the price of nothing: the honest proposer never sends two at one attempt, so the rule is free
for it, and a proposer that restarted behind is moved past the mark by the stale answer: `staleAttemptIsAnsweredWithTheMarkTest`, where `forgetAttempt` stands for the restart); (2) the fork found by the kernel review (A4a): the receiver refuses
a frame, the proposer (after its budget) drops the tx, the receiver's view of J then moves and the SAME frame becomes applicable. Without the mark the receiver would hold it, ack it and commit a frame its peer dropped: the two replicas
fork. With the mark the frame is refused again for as long as the head lasts. `refusedFrameIsNeverTakenWhileTheHeadLastsTest` is that schedule (three refusals, the budget spent, the receiver's clock ticks, the frame arrives again at the mark; the
older ones arrive below it); mutants `receiver-commits-a-refused-frame` (no mark kept) and `refused-frame-judged-afresh-at-same-attempt` (`<` instead of `<=`). Two checks state it on the outcome and not through the guard: the oracle `wellFormed`
now also requires a held frame to be above the mark, and `no_orphan` says a side never holds as committed a frame its author has given up (it has committed it too, or still has it in flight). Not modelled: attempts outside a safe integer (the code
bounds the receiver's check there; here the attempt is an unbounded integer and only the Byzantine actions pick it, from 0 to `MAX_ATTEMPT + 1`); persistence (the Runtime must persist `attempt` and the mark, or a restart reopens the fork).

**A18. The proof nonce of a retry. DECIDED (coordinator 10-01 05:19, R-RETRY-NEW-NONCE; found by the model while doing A16).**
Decision: a retry signs its proof at a fresh nonce; the contract never needs stored + 1 for a signed proof (start > stored, counter >= opening, finalize >= stored), so the nonce counter may have gaps, but only after a refused attempt. The rest of this entry is how it was found and the first model of it. **The formula below, `pnonce + 1 + attempt`, did NOT satisfy R-PROOF-NONCE-ABOVE-SIGNED (coordinator 05:45) and is replaced by A19** (kept here as the record; the mutants `retry-reuses-the-nonce` and `nonce-from-the-committed-tip` are the two versions of the bug).
The decided rules do not fit together here. R-PROOF-NONCE says the proof nonce is gapless and signatures are one per (signer, nonce, author side); the proposer signs the proof of a frame when it PROPOSES (A5), and a refused frame is rolled back. A
retry that dropped a tx re-proposes at the same height, so at the same nonce, with a different proof: the proposer signs a second, different proof under one (signer, nonce, side), which is exactly what `no_equivocation` (A13) forbids, and the peer
holds both signatures (it can start a dispute on the abandoned one, and the retry cannot counter it: the same rank). The first version of the scenario test (b) showed it (`no_equivocation` false at the end of the drop schedule); a retry that drops nothing
signs the same proof and is harmless.
Choice made so that `safe` keeps its meaning (to be confirmed or replaced): a frame at attempt `a` is at proof nonce `pnonce + 1 + a`, so every abandoned attempt keeps its own nonce and the retry outranks it; the receiver's window is widened by the
frame's own attempt and by nothing else (`inLine`); `nonce_climbs` says a committed frame is above its parent's nonce by one plus its attempt at most; `MAX_NONCE` grows to cover it. Cost: the counter has gaps after a refusal (the one exception to
"nothing skips"), and a Byzantine proposer can burn its own counter by claiming a high attempt. Mutants `retry-reuses-the-nonce` (killed by the drop test, whose `safe` fails on `no_equivocation`) and `nonce-window-ignores-the-attempt`. The alternative is to keep the nonce
and let the retry equivocate (an abandoned proposal stays a standing offer anyway, A5), which weakens P4b to "no second proof once the first was acked". The kernel has no proof nonce yet (owed with R-PROOF-NONCE), so nothing there contradicts either.

**A19. R-PROOF-NONCE-ABOVE-SIGNED: a committed frame is above every proof either side signed (coordinator 10-01 05:45; Review A of PR 97). The model did not satisfy it; fixed here.**
The rule: every committed frame's proof nonce is strictly above every proof nonce either side signed in the epoch, the attempts that were yielded or refused included; and no two different proofs share a nonce. Why it matters: a proof is signed when it is PROPOSED (A5), the peer holds it, and a start needs a proof signed by the OTHER party only (`chain.qnt` `canStart`), so an abandoned proof is enforceable until a frame of higher rank commits; if it outranks the committed head (rank = nonce * 2 + leftAuthored, A12) the peer can start with it and the chain settles an older body than the one both sides committed.
The two schedules of Review A, planted as scenario tests, each with its mutant:
(a) `yieldAtTheRetryLeavesNoHigherProofTest`: Right's first frame (a lock whose deadline is too far for Left's view) is refused; Right retries at attempt 1 while Left proposes its first frame in the meantime; the two collide, Right yields (A12, Left wins a collision) and Left's frame commits. Under the old rule (`pnonce + 1 + attempt` from the committed tip) Left's frame was at nonce 1 and the retry at 2, ABOVE it, so the proof Right signed and then yielded outranked the committed head, and Left, holding it, could start a dispute and erase the frame. Now both are at nonce 2 (Left above the refused proof it has seen, Right above its own), the collision is the ordinary one, and the yielded Right-authored proof ranks below the committed Left-authored one (`proofRank(frames.get(3)) < proofRank(frames.get(2))`); Right's lock then goes out again at nonce 3 and commits. Mutants `nonce-from-the-committed-tip` (the nonce is taken from the committed tip: the reused slot) and `proposer-may-sign-below-what-it-knows`.
(b) `refuseThenCommitAtTheSameNonceLeavesNoHigherProofTest`: Right refuses Left's first attempt (nonce 2, Left-authored; its lock is too far for Right's view), and then proposes its own frame (a payment to Left). Left's refused proof at nonce 2 is held by Right and is enforceable; Right's own frame must be above it, at 3. At 2 (the committed tip plus one: the old rule, mutant `nonce-ignores-seen-proofs`) it ties the proof Left signed, and at one nonce the chain ranks the Left-authored proof above the Right-authored one: Right, holding Left's stale proof, starts a dispute with it and erases the frame that committed. Mutant `retry-reuses-the-nonce` is the same bug on the retry of one's own frame.
The model, each part with its mutant. Per replica: `hi`, the highest proof nonce this side knows was signed: its own proofs, and the peer's in any frame next in line (held, refused or ignored in a collision), since those are signed too; `sig`, the highest rank this side itself signed (as a proposer when it proposes, as an acker when it acks).
(1) The proposer signs at `max(pnonce, hi) + 1` (`frameToPropose`; `nonce-from-the-committed-tip`, `nonce-ignores-seen-proofs`, `proposer-may-sign-below-what-it-knows`).
(2) The acker acks a frame only if its RANK is above `sig` (`nonceOk`, part of `acceptable`; `acker-ignores-its-own-signed-proofs`, `receiver-compares-nonces-not-ranks`: the comparison is of ranks, so a Right-authored frame at the nonce of a Left proof the acker signed is below it, a Left-authored one at the same nonce is above a Right proof), else it answers with a refusal `nonce_low`. The proposer treats `nonce_low` like a stale attempt: no tx is lost whatever the budget (`nonce-low-drops-the-tx`).
(3) **The slot and the floor (coordinator 10-01, from the kernel PR 97 round 2, head 2f81bd4).** The slot of a frame is its `nonce` (`pnonce + 1 + attempt` is gone: the slot is above every proof either side signed, `max(pnonce, hi) + 1`). EVERY refusal carries the refuser's signed floor, its `hi` (`answerFor`, for every fault: `refusal-without-floor`; `everyRefusalCarriesTheFloorTest`), and the proposer raises its own `hi` to it, so the retry is signed above it (`refusal-floor-ignored`). A slot or a floor more than one step beyond what an honest peer could reach is refused: a slot above `hi + 1` by the receiver (`inLine`; `accept-proof-nonce-leap`, `window-ignores-the-seen-proofs`; `leapingProofNonceIsRefusedTest`, `windowIsOneAboveWhatTheReceiverKnowsTest`), a floor above the proposer's `hi + 1` by the proposer: the refusal is refused, the frame stays in flight and nothing changes, so a Byzantine receiver can neither burn the proof counter nor make the proposer drop a tx (`floor-beyond-the-bound-accepted`; `nonceLowCostsNoTxTest`; this replaces the earlier clamp at `hi + 1 + MAX_ATTEMPT`). The bound is what an honest peer can reach: its own latest proof, which the proposer has not seen, and nothing more (every earlier proof was seen, since a retry follows a refusal and a commit follows an ack); the oracle `refusal_floor_reachable` (P4i, in `safe`) states it on the refusals in flight, so an honest refusal is never refused by the bound. The floor is what the refuser held before it saw the frame (the proposer knows its own proof).
(4) **A collision is won by the higher slot, and at one slot by the Left-authored frame (R-A1 by rank).** The receiver of a frame at the height of its own in-flight frame compares `proofRank` (nonce * 2 + leftAuthored): the higher keeps its frame in flight and ignores the other, the lower takes the other (Right did this always, Left never; now either). The loser's proof stays signed below the winner's, so the committed head is above it (`signed_above_head`). Test `collisionIsWonByTheHigherSlotTest` (Left holds frame 2 at slot 2, Right refuses it and signs frame 3 at slot 3, frame 3 reaches Left before the refusal: Left yields); `collisionLeftWinsTest` still states the tie. Mutants `collision-won-by-the-lower-slot` (the winner is the lower rank) and `collision-left-always-wins` (the rule before the slot); `collision-both-roll-back` and `left-also-rolls-back` are re-pointed at the new rule. The Entity (`entity.qnt`) still keeps Left's frame on a collision: it has no slot (no proof nonce), so the two rules agree there only at one slot, and the Entity's collision is owed the slot with the rest of A20's gap.
(5) The receiver's window is one above what it knows signed (`inLine`: `nonce <= hi + 1 + MAX_NONCE_GAP`), which replaces the old window widened by the frame's own attempt (the mutant `nonce-window-ignores-the-attempt` is removed with the rule it pinned). The gaps are exactly the signed proofs the other side has not committed. `commit` raises `hi` and `sig` (`commit-forgets-the-signed-rank`).
**Open point: the naming of the signed bytes.** The kernel's round 2 has the signed frame and the signed refusal name the chain, the depository, the Account and the epoch, so that a proof or a refusal signed for one Account or epoch cannot be replayed in another. The model has no place for it: it is one Account in one epoch (`settle.qnt` models the epoch boundary, over a chain with one Account), a frame carries no chain, depository or Account id, and signatures are not bytes but the table `signed` keyed by (signer, nonce, branch). Nothing here can show a replay across Accounts or epochs, and no mutant of it is claimed. Owed, if the coordinator wants the property: an `account id` and `epoch` in the frame and the refusal, a receiver that refuses a frame or a floor for another Account or epoch, and a Byzantine action that replays a frame or a refusal from another one.
Oracle on the signed-proof history, independent of the guards (`hi`, `sig`, `nonceOk`): `signed_above_head` (in `safe`, P4g): for each honest replica and every proof in the signature table `signed` (by an honest signer; a Byzantine side's own signatures cannot hurt it), the proof is the head, one of the head's two ancestors, a live proposal on the head (or built on one: not stale yet), or ranks BELOW the head's rank by the chain's order. Any other proof is a stale one above the head. `nonce_climbs` (P4f) is restated: a committed frame is above its parent, and the nonces it skipped are only ones a signed proof occupies (the oracle `no_bad_accept`/`wellFormed` still states the window on its own). Witnesses `w_no_nonce_low` (a `nonce_low` refusal is reached) and `w_no_stale_signed` (a signed proof of a frame that did not commit sits below the head: the case the oracle judges).
"No two different proofs share a nonce" is checked per author branch: one signer signs one proof per (nonce, author side) (`no_equivocation`, keyed by (signer, nonce, branch)). Two proofs of DIFFERENT authors at one nonce are still possible, in exactly the simultaneous collision (both propose at the same nonce, unseen by each other; Right yields to Left); the chain's rank breaks that tie for Left, and the Left-authored frame is the one that commits, so no proof stays above the head (`signed_above_head`). **Read to the coordinator:** if the rule means one proof per nonce across both authors, the collision would need a nonce bump for the yielder before it proposes, which it cannot know; I did not model that, and the question is open.
Cost to state: the counter has gaps after any signed proof the other side does not commit; a Byzantine proposer cannot leap (the receiver's window is `hi + 1`), and a floor more than one above the proposer's `hi` is refused (nothing is learned from it); `MAX_NONCE` grows to cover the attempts.
Not modelled: the epoch boundary (the first proof of a new epoch is `settle.qnt`'s `FIRST_GAP`, from the chain's stored nonce); the persistence of `hi` and `sig` (the Runtime must persist them with the frame, or a restart can sign below a proof it signed before).

**A20. R-SIGNED-IS-LIVE: a refusal or a yield must not release a hold while the lock sits in a signed proof that nothing has superseded (coordinator 10-01 05:45; Review A of PR 97).**
The bug: the payer's side drops a lock tx with notice (a refusal, a collision yield) and the Entity above fails the upstream hold back (or the payer spends the room), while the proof the payer signed for that frame is still held by the peer and enforceable on the chain: the peer starts a dispute with it, reveals the secret in time, and the lock pays the peer, so the hub that released its upstream hold now pays twice. The model's R-NOTICE (A16: a refused tx is noticed at once, `no_tx_lost`) was in effect this bug: the notice IS the release. The model had no place for the release: a notice was a list entry the Entity above never read, so nothing could be wrong with it. The smallest honest model added here: the release is a separate step.
`sigLocks`: the lock txs of the proofs this side signed (`signsFrame`, at propose) with the rank of each; `commit` drops those whose rank is below the committed frame's (supersession; `commit-keeps-superseded-locks`, `commit-supersedes-by-nonce-not-rank`, `commit-forgets-the-signed-rank`; `signing-forgets-the-locks`). A tx cut with notice (`withNotice`, from `onRefusal`, `propose` and `reviseMempool`) goes to `refused` (released) unless it is a lock in `sigLocks`, in which case it goes to `kept`; a non-lock is never held (`non-lock-notice-waits`). `releaseHold` (an action, like the Entity reading its notices) moves a `kept` tx to `refused` only when `releasable`: a frame above its proof has committed (it left `sigLocks`), or the side's own clock is past the lock's deadline plus `CLOCK_RESERVE` (R-HORIZON-RESERVE: after that nothing can reveal in time; `release-ignores-the-reserve`, `release-before-supersession`). A kept notice is never lost (`release-loses-the-notice`; `no_tx_lost` counts `kept` among the txs a side still answers for).
Tests: `refusalDoesNotReleaseTheHoldTest` (a lock in a signed proof is refused after the frame: the notice waits), `supersessionReleasesTheHoldTest`, `releaseWaitsForTheDeadlineAndTheReserveTest`, `onlyALockInASignedProofWaitsTest`, `commitSupersedesOnlyLowerRanksTest`. Mutant `refusal-releases-hold` is the planted bug: the refusal releases at once (killed by `refusalDoesNotReleaseTheHoldTest`). Ghost `relBad` and the oracle `no_release_while_signed_live` (in `safe`) state it on the outcome: a lock in a released notice must not be in a signed proof that is live and not past its deadline plus reserve. Witnesses `w_no_kept`.
Chain-side evidence (`compose.qnt`, the Account's bodies settled by the chain's own game): `refusedProofWithTheLockIsEnforcedOnTheChainTest` (a hub's refused frame with a lock: the next hop, holding the proof the hub signed at propose, starts a dispute with it and the chain, with nothing above it to counter with, settles it: the lock pays the next hop once it knows the secret, so a hub that released its upstream hold at the refusal owes what nobody covers; mutant `start-requires-both-signatures`) and `supersededProofIsCounteredOnTheChainTest` (the same history with a frame above the stale proof committed: the counter outranks it and the lock is gone, which is what supersession buys). The same tests state the other half, A19's schedule (b): `staleProofAtTheCommittedNonceErasesThePaymentTest` (a committed payment at the nonce of a Left-authored stale proof is erased: the proof wins the rank tie; mutant `rank-ignores-the-author`, the chain ordering proofs by nonce alone, fails it) and `staleProofBelowTheCommittedNonceIsCounteredTest` (the committed frame above the stale nonce stands).
**Gap, recorded: the Entity layer has nothing to release.** `entity.qnt` has no refusal of its own frame (`ackOf` never receives one; `arrive` counts a peer's refused frame), no proof nonce and no signed-proof state: a frame in flight is committed or silently kept, and the upstream hold fails back only through the route's own expiry. So R-SIGNED-IS-LIVE cannot be checked at the Entity level, and the rule it must obey is owed there: the Entity may fail an upstream hold back on an Account refusal only for a tx the Account has released (`refused`), never for a `kept` one. The Account's two sets are the interface; the Entity must read `refused` for releases and treat `kept` as still held until the Account releases it. Owed with the Entity's own refusal handling.

**A21. R-COSIGN-FREEZE: a side that co-signed a settlement or a reserve-to-collateral proposes nothing and refuses every peer frame, until the operation is over (coordinator, after PR 44).**
The rule, both ways: after a side co-signs a fold (a cooperative settlement, or a reserve-to-collateral move; both fold the head's offdelta into the signed body), (1) it proposes no frame, and (2) it answers every peer frame with a retryable `frozen` refusal, until the operation lands, is superseded, or the host reports it lapsed. Why: the fold carries the offdelta of the head it was taken at; a frame committed after it moves that offdelta, and the chain is then given a balance the Account no longer has (a payment lost or doubled by the landing).
Model (`account_core.qnt`, `account.qnt`): `Replica.frozen`, `foldH` and `fold` (the committed height and the offdelta of the head the fold was taken at). Action `cosign(s)`: only at a head with nothing in flight (no frame proposed, none held), records the fold. `canPropose` is false while frozen (way 1); `acceptable` is false while frozen and `judge` answers a frame next in line with fault `frozen`, index 0, carrying the refuser's floor like every refusal (way 2); `frozen` is retryable (`retryable`), so the proposer's retry budget applies as for the other retryable faults. Action `thaw(s)` is the one action that stands for the three ends (landed, superseded, lapsed): it clears the flag. Oracle `cosign_fold_holds` (P4j, in `safe`), on the signed fold against the off-chain state and not through the two guards: while a side is frozen its committed height is the fold's height, its head's offdelta is the fold's offdelta, and it has no frame in flight or held.
Tests: `cosignRefusesPeerFramesUntilReleasedTest` (Right's payment is refused `frozen`, costs no tx, the attempt counts up, and it commits after the thaw), `frozenSideProposesNothingTest`, `cosignRefusedWhileAFrameIsInFlightTest`, `cosignRefusedWhileAFrameIsHeldTest`. Mutants: `frozen-side-accepts-the-peer-frame` (the planted bug: the head's offdelta moves after the fold was signed), `frozen-side-proposes`, `frozen-refusal-is-not-retryable` (the payment is dropped with notice for a state that passes), `cosign-with-a-frame-in-flight`. Witnesses `w_no_frozen`, `w_no_frozen_refusal`. A Byzantine receiver may name `frozen` (`FAULTS`).
Not modelled, recorded: (a) the end of the operation. `thaw` does not change the body: a settlement that LANDS folds the offdelta into the ondelta and opens the next epoch (`settle.qnt` models that over the chain), and the Account layer here has one epoch; so the three ends are one action and the body after a landing is not shown. (b) A settlement and a reserve-to-collateral are one `cosign`: the Account layer has no collateral or reserve, so nothing tells them apart. (c) The retry budget (`MAX_ATTEMPT`) applies to `frozen` as to the other retryable faults: a peer frozen for longer than the budget has the tx dropped with notice. The kernel's pacing of the retries is the Runtime's policy (A16); whether a `frozen` refusal should spend the budget at all is a question for the coordinator. (d) The Entity (`entity.qnt`) has no such frame refusal (A20): nothing there refuses a frame as frozen.

**A11. Not yet in this layer** (each tracked in PROGRESS.md): cooperative settlement and the on-chain epoch (N1:
sign proofs only for the current epoch; pause payments until the epoch event is read, then the first proof of the epoch takes the chain's stored
nonce + 2, R-IMPLICIT-BASELINE; settle.qnt), account open
(Q-A1), windows that never shorten inside an epoch (N3, C13), swaps, multiple tokens. A Byzantine peer is modelled (A3, A5, A12).
R-HOLD-CAP is per Account across tokens (32, the contract's per-body cap). It is owed when the multi-token Account is modelled.

**A12. A peer that acked a frame and then sends another for the same height. CLOSED by rank (coordinator, 2026-09-30).**
Found by simulation. Right proposes frame 1; Left acks it and commits; the ack is lost. Left's key is then taken, and it sends Right another frame for height 1
(`byzStamped`). Right, still waiting for its ack, is the collision loser: it rolls its own frame back and takes Left's. The two sides hold different bodies at height 1.
Resolution: at one proof nonce the chain ranks a proof by `nonce * 2 + leftAuthored`, so the Left-authored proof wins in a fixed order whoever starts or counters. The honest
Right signed that Left-authored frame itself under the Left-priority rule, so nobody honest is hurt: the frame Right holds is the one the chain settles, and Left's earlier
Right-authored proof cannot beat it. In the model `agreed` excuses exactly this (a later Left-authored commit over an earlier Right-authored one, only with a Byzantine peer:
`mismatch`), not the reverse order and not two honest sides. Test `equivocatingLeftIsSupersededByRankTest`; mutant `supersession-reversed`; witness `w_no_supersede`.
**Final review F9 (coordinator 2026-09-30):** the exemption compares ranks, not only authors: a later Left-authored commit is excused only when its nonce is not below the earlier Right-authored one's
(`mismatch`), so `agreed` stands on its own and does not lean on `MAX_NONCE_GAP = 0` (A13 still fixes the gap at 0 for `no_equivocation`). A consequence to state plainly: with the correct model
the four widenings of the exemption are equivalent mutants (only one order of authors ever commits twice at a height), so `agreed` bites only under injected faults.
**Generalised by rank (found by a longer simulation of this branch: 1500 traces, seed 0x3; the same fork is reachable on the base branch, reproduced there as a scenario).** A peer that acks Right's frame (it commits; the ack is lost), is then taken, REFUSES that frame and acks Right's retry leaves the sides on two Right-authored bodies at one height: the retry is at a higher nonce, so the chain settles it, and Right signed it itself. The exemption said "a Left-authored frame over a Right-authored one", so this read as a fork. It now says what the rule always was: with a Byzantine peer, a later commit is no fork when its RANK is above the earlier commit's (`mismatch`: `proofRank(f) > proofRank(earlier)`; the Left-over-Right case at a nonce not below is the special case). Test `ackedThenRefusedThenRetryAckedIsSupersededByRankTest`; mutants `supersession-reversed` (the order reversed) and `supersession-by-author-only` (the first statement of the exemption). Honest sides are still held to equal bodies (no Byzantine peer: no exemption).
Restricting the exemption to a Byzantine peer is not checkable by mutant: two honest sides never reach that ordering (honest Left never proposes a second frame for a height it committed),
so dropping the restriction is an equivalent mutant, and the restriction is a statement of intent.

**A13. The proof nonce is its own counter (N1, coordinator; found while doing it).**
Choice: a frame carries a `nonce`, the proof nonce a dispute start would use; each replica keeps `pnonce`, the nonce of the frame it committed last. A receiver
refuses a frame whose nonce is not above its `pnonce`, or leaps more than `MAX_NONCE_GAP`; signatures are keyed by (signer, nonce, branch). Within an epoch the
nonce follows the tip by exactly one (`MAX_NONCE_GAP = 0`; gaps only where a signed proof sits: a refused or yielded attempt, R-RETRY-NEW-NONCE, A18, A19); the one jump is the first proof of a new epoch, stored + 2 by rule (R-IMPLICIT-BASELINE, `settle.qnt` `FIRST_GAP`, C13),
chosen from the chain's stored nonce and not by a frame's proposer. **Why not
a free gap:** with `MAX_NONCE_GAP = 1` (mutant `proposer-may-skip-nonces`) a collision loser's abandoned proposal at nonce n+1 outranks the winner's frame at n, and
the loser's next frame at n+1 signs a second proof under one key: `no_equivocation` fails, simulation finds it. The chain rule the model relies on is "a proof
nonce is used once per key, and a start needs one above the stored nonce". Checked by `nonce_climbs`, `no_bad_accept` (independent oracle `wellFormed` states the nonce
rule), mutants `accept-stale-proof-nonce`, `accept-proof-nonce-leap`, `commit-forgets-proof-nonce`. The Byzantine frames of kind 4 and 5 carry a stale and a leaping nonce.



**A14. The link: an unordered set with free redelivery (recorded as a choice, coordinator 09-30, D-AC-8).**
`proposals` and `acks` are sets; delivery does not consume a message, so any message in flight can be delivered any number of times in any order, and a lost message
is one removed from the set. This was not written down as a question. It is the harsher model than the Arrival page's (FIFO, one loss, one duplicate), and stays: the Arrival
checker showed that widening its link to deliver any of the first three messages keeps every property and liveness (7312 states), so the two models agree on what holds.
Consequence for trace replay: a Quint trace may deliver out of order, and a replay on a FIFO page needs a bridge step (`review/account-comparison/`).

---

# J layer (chain.qnt): the Depository as one Account sees it

**C1. Scope: one Account, one token, signed proofs as an arena.**
The chain model does not run the Account protocol; it takes an honest-shaped history of signed proofs as given at
init (both-signed states at nonces 1..k, an unacked proposal at k+1, a Right proposal that lost a collision at k, the
first signed frame of the next epoch at nonce 7 and one proposal on it at 8; from epoch 1 a dispute may also start from the implicit proof, C13) and lets the chain rules decide which can settle. Composition with
`account.qnt` (real histories) is the next step. Choice made because the dispute game is the hard part and the arena
makes Apalache-sized checking possible.

**C2. What "the honest party's belief" is (P1).**
Options: (a) only the latest both-signed proof; (b) also any newer proof the honest party itself signed.
Choice: (b). Signing a proposal is consent to it (design/account-model.md section 2), and the proposer's signature over
its own proposal is an enforceable dispute proof, so an adversary that presents it is not cheating. P1 therefore is:
every settled proof is of the current epoch and is either the highest both-signed proof, or newer and signed by the honest
party. The honest party can lose only if it is offline while a response is due (C7).

**C3. Nonce after finalize. CLOSED (coordinator, N1 addendum).**
Contracts: a finalize of the initial proof stores nonce n0+1; adopting a counter-proof or newer proof stores that nonce.
Both are followed. Consequence, not written anywhere in the sources: the stored nonce after a finalize can exceed the
height of the next off-chain frame, and `disputeStart` requires proof nonce > stored nonce. So the first proof of a new
epoch must carry a nonce above the chain's, not the frame height. Decision: off-chain frame height and proof nonce are separate counters. Superseded in
its second half by R-IMPLICIT-BASELINE (C13): there is no co-signed baseline any more, and the first signed proof of the epoch carries the stored nonce + 2, the stored nonce
read from the chain (a timeout finalize leaves initial + 1, a counter or a signed branch the proof's own nonce, an update its own).

**C4. R2C is allowed during a dispute. CLOSED (coordinator: accepted as is, recorded as H4 in contracts-decisions.md).**
Account.sol `processR2C` has no dispute check. The model follows the contract: a deposit made during a dispute changes
the collateral and (crediting Left) ondelta, and finalize pays from the values at finalize time. A proof fixes only
offdelta. Neither side can lose by this: each deposit raises only its beneficiary's allocation. R2C does not advance the
epoch because no signature is involved. Open: whether to forbid it in the fixed contracts (simpler to reason about, but a
liveness cost for top-ups during a dispute); nothing in the model breaks if not.

**C5. Debt is lazy and unsecured.**
Payout shortfall pays from spendable reserve (reserve minus outstanding debt) after enforcing older debt, and books the
rest as debt. A later inflow does not pay debt; `enforceDebts` runs before the next outflow. P3 therefore counts
reserves plus collateral only, and `debt_only_when_broke` checks that debt is never booked while the debtor could pay.
The FIFO queue over several creditors is reduced to one creditor (the counterparty).

**C6. When the honest payee publishes a secret (deadline tolerance).**
The model's honest party publishes the moment it learns a secret for an open clause it is the payee of, i.e. the
tolerance is zero. A real party may wait, at the price of the tolerance parameter (coordinator decision: per-party policy,
not a protocol constant). The guarantee P1 gives is exactly "the payee is paid if it published by the deadline".

**C7. What "honest party offline" excuses.**
Time is a tick clock. A tick that passes while the honest party is offline and owes a response (a counter-proof, or a
secret to publish) sets a flag that switches P1 off: nothing can protect a party that never answers. Ticks that pass
while nothing is due do not count. So P1 is the statement "if the honest party answers within one tick of every duty,
it is never paid less than what it agreed to".

**C8. Evidence for a clause at finalize.**
A clause pays iff its secret is public by the deadline (registry), or the starter revealed it in start arguments (frozen
at start, evaluated at the dispute start time), or the non-starter reveals it in the finalize call (evaluated at finalize
time). The starter's frozen arguments are per branch: the initial proof, or the one named counter branch. Source:
Account.sol prepareDisputeFinalization, DeltaTransformer timestamps.

**C9. H1 is a wait, not a rule about who is paid.**
Finalize reverts while a clause is unrevealed and its deadline is open. The honest payee that knows the secret can end
the wait by publishing it. The model makes no separate claim about hubs that do not yet know the secret; they wait
until the deadline, then settle unpaid, and the upstream Account is then paid nothing for that clause. That is the
intended trade (a hub must not settle an inbound Account before its outbound lock is resolved), stated here so the
Entity layer can require it of the hub: an Entity with a forwarded HTLC starts and answers disputes on both Accounts
before the shorter deadline. Source: contracts-decisions H1.

**C10. Not in this layer.** Pull-carrying proofs (path 2 excludes them; swaps are v2), H3 (retired-board evidence needs
board rotation, so it belongs in entity.qnt), cooperative settlement and C2R (they advance the epoch too; settle.qnt),
several tokens, C2 (batch authority is per entity; nothing visible in a one-Account model), per-batch atomicity across
Accounts (N2: finalizes are submitted per Account, so one action is one batch).

**C11. The honest side takes time: a floor for the windows, derived. ACCEPTED by the coordinator (2026-09-29).**
Until now the chain model let the honest party answer at the same tick as the event ("time does not move while a response is
due"). A real party reads the chain LAG ticks late and its answer needs LAG ticks to be included, so it answers REACT = 2 * LAG
after the event, and the adversary gets those ticks for free. The model now makes time stop only REACT ticks after the start
(or after the last counter), or LAG ticks after the payee learned the secret (that one needs no read). Consequence, and the rule
the contracts must meet: **the two windows of a dispute together must exceed REACT** (`wl + wr > 2 * LAG`; with LAG = 1 the
model floor is 2 ticks per window; the contracts' 60 s floor meets it while a J event is read and included in under 60 s). Options: (a) floor per window `MIN_WINDOW >= LAG + 1`, (b) floor on the
sum. Choice: (a), it is what the contract can check on one proof, and it keeps H2's shape (a per-window floor). The deployment
numbers are what the coordinator decides: a floor in blocks that is several times the slowest read + inclusion. Model evidence:
`window-floor-below-react` (MIN_WINDOW = 1: the adversary finalizes a stale proof at the tick the answer would have landed),
`react-longer-than-windows`, `lastMomentCounterStillWinsTest`. The Entity side is `answer_in_window` (`windows-shorter-than-answer`);
`params_test.qnt` pins the shared numbers (LAG, REACT, DWIN, HOP >= REACT, ESC >= LAG), so a change to one layer fails the test.
A second consequence: a payee that learns the secret at the deadline is not owed payment (its publish needs LAG): the property
`p1_clause` reads "learned at least LAG before the deadline" (`no-publish-tolerance`). This is the deadline tolerance of E3 seen
from the chain. Source: R-P2, H2.

---

# Settlement and epochs (settle.qnt)

**S1. The Account state machine gains a lock.**
A cooperative update is agreed in an ordinary frame (the "Lock" frame: the diffs, `dl`, `dr`, and the nonce of the update).
From the moment it commits, the Account accepts no payment until the epoch that update opens is read from the chain (or a
dispute replaces it); the first proof after that takes the stored nonce + 2 (R-IMPLICIT-BASELINE, C13). This is N1. Three rules make it hold, each killed by a mutant:
(a) the honest side re-applies its signing rules when an ack arrives, not only when it offers: an offer signed before the
chain moved is dropped; (b) a side that starts (or answers) a dispute stops signing at that moment, before it has read the block;
(c) a payment signed for an epoch the chain has left is never committed by a payee.

**S1a. R-SETTLE-CREDIT (Q-X-3, coordinator 09-30).** A party co-signs a settlement that withdraws collateral only if, after it, each side's
position is still within the credit the other side extended: the payment bound, over the collateral that remains (a Left withdrawal lowers Left's
allocation with the collateral; a Right withdrawal leaves it). The contract accepts a settlement that breaks it (credit is off-chain, R-A6), so the
approver is the only guard. The rule is `settlementOk` in `account_core.qnt`; `settlementKeepsCreditTest` in `compose.qnt` settles every outcome of the open
clauses of every RCPAN Body over the smaller collateral with the chain's `payout` and checks no side owes more than the credit granted. It also
checks that the domain has both answers (a withdrawal inside the claim is co-signed, one beyond it is refused). Mutants: `settlement-ignores-credit`,
`settlement-ignores-open-clauses`, `settlement-checks-the-old-collateral`, `settlement-left-keeps-its-claim` (all killed by that test). The test rig's case:
a co-signed settlement left Left at delta -7,000,031 against credit 18,092. Not modelled here: the approval inside the settle.qnt state machine (it has
no credit limits); the predicate is what the pure/ approval must implement.

**S2. The update is signed by the side that does not submit it.**
Depository `_settleDiffs` verifies the counterparty's current-board hanko over `(epoch, nonce, diffs, forgive)`; the submitter
is authorised by its own batch. So one signature is enough to execute, and whoever holds the other side's signature can execute at
any time until the epoch or nonce moves. The update dies with any other epoch event (finalize, another update); it cannot
execute during a dispute. Source: `Account.sol:1540-1650`.

**S3. SUPERSEDED by R-IMPLICIT-BASELINE (coordinator 09-30, C13). Was: N1 as decided leaves a window in which the honest side has no proof for the epoch.**
History: after an update executes every earlier proof is dead (C1), and with a co-signed baseline the honest side had no proof for the new epoch until the baseline was signed (a hostage
situation, not theft). Three answers were weighed: (a) bound it by policy; (b) co-sign a baseline of epoch + 1 with every frame at nonce + 3 and fold the offdelta into the ondelta (adopted
on 09-29, with `presign` and `rebase` modes, `BASELINE_GAP`, `baseline_clears`); (c) a contract change: every epoch starts with an implicit baseline. **(c) is what was decided**, in a form that needs
no signature at all: the implicit proof of C13 (empty state, Right-authored, at stored + 1). This module's baseline machinery is gone: `BASELINE_GAP`, `baselineOf`, the `presign` mode, the Rebase frame and
`baseline_clears`, and their tests and mutants. What stays from (b): the update still folds the agreed offdelta into the ondelta (`ondeltaDiff = -dl + offdelta`), now always, because the implicit
proof pays offdelta 0 over the new ondelta, so what both agreed is exactly what it pays (`settlementOpensNextEpochTest`, `claims_conserved`; mutants `update-does-not-fold`, `fold-wrong-sign`). A settlement
still requires no open clauses in v1 (the fold would drop one; R-A3 forbids settling over queued work, enforced in the Entity layer).
Result: `hostage_free` holds in every state (the honest side can start from a signed proof of the epoch or from the implicit one, `settlementOpensNextEpochTest` checks it before the side has even
read the chain); the cost is a new rule for the first signed proof of the epoch, nonce >= stored + 2 (the trap, C13), judged by `first_proof_at_stored_plus_two`. `firstProofReadsTheStoredNonceFromTheChainTest`
runs the schedule where the stored nonce is not the Account's own tip plus anything (Left starts with Right's unacked proposal at 3 and lets the window run out: stored 4, the first proof of the new epoch at 6); the mutant
`first-proof-nonce-derived-from-the-tip` is killed by it (R-IMPLICIT-NONCE-FROM-CHAIN).

**S3b. A party that starts a dispute uses its newest co-signed proof (coordinator, 17:36Z).**
An older proof, or a proposal it has not seen countersigned, is presentable on chain and can be the one that settles, so the
starter never picks by convenience: `honestStart` uses `tipId`. `starterUsesNewestProofTest` and the mutant
`honest-starts-with-older-proof` (chain.json) pin it: with nobody answering, the older proof would be paid.

**S4. Fund only into an Account you hold a proof for.**
Found by simulation: after a finalize opened epoch 1 (under the old N1) the Account had no proof; a deposit into it is a stake nobody can
enforce. Rule: a side runs R2C only when it holds a proof a dispute could start with: a both-signed one of the current epoch, or, from epoch 1, the implicit proof (C13), which is always there. At epoch 0
that is the first co-signed frame (R-NO-DEPOSIT-BEFORE-COSIGN). This is the "open" protocol of Q-A1 stated as an order of operations: co-sign the first frame, then fund.

**S5. Lag between the chain and a side.**
Each side reads the chain with a delay. The model lets it act on a stale view but requires the honest side to read the chain
before time passes (a tick). That is the bound "J event lag + processing < response window". C11 now derives it: the H2 floor
(60 s per window in the contracts) has to exceed LAG, so that both windows together exceed REACT = 2 * LAG; the protocol cannot
enforce the lag, so LAG is the deployment number written next to the floor.

**S6. Not modelled here.** Open clauses in a settlement (fold kills them; the spec only says refuse), several tokens, debt
forgiveness (`forgiveDebtsInTokenIds`), an `ondeltaDiff` that changes what a side is owed (a settlement paying an off-chain
balance out of reserves; the two shapes covered are custody-only and fold), credit limits across epochs, and the Entity's
choice of when to settle.

---

# The Entity (entity.qnt)

The Entity under test is a hub with two Accounts: IN (peer 1 sends, we are the payee of its locks) and OUT (we send on to peer 2,
we are the payer). Both peers are adversaries; the Entity is honest and online.

**E1. One frame, four phases, several inputs. CLOSED.**
A frame is a pure function `frameOf(state, inputs)`: (1) the inputs: peers' frames and acks, then J events; (2) the hooks:
resolve, expire, route, fail back, escalate, reveal, all reading the state after the inputs; (3) a signed local command;
(4) one proposal per Account, ascending. Inside a batch the order is: peer frames first, then J events (then the command). A
dispute event that arrives with a peer frame then freezes the Account with evidence that includes the frame
(`peerFrameBeforeChainEventTest`); the other order freezes first and the frame changes nothing (`chainEventBeforePeerFrameDiffersTest`),
so the order is a rule, and it is the Runtime's canonical order (runtime.qnt R1). The action `feedTwo` feeds any two inputs in that
order and the invariants hold over 5000 traces; `only-first-input-of-a-frame` is killed by `ackAndRefusalInOneFrameTest`. Source: R-E4,
R-P4; the batch order is mine (lessons.md does not fix it).

**E2. What is and is not modelled.**
A hub, one token, one route per slot (IN slot k feeds OUT slot k), amount 1 or 2, two secrets. The Entity's reaction time is
zero ticks: time advances only when the Entity has nothing left to do at this tick (a checked assumption, not a rule the protocol
can enforce; the deployment number is "processing < one tick"). The two replicas of one Account are account.qnt's business; here a
peer frame is one transaction, validated, applied and acked at once. Not modelled: several routes per slot, tokens, boards, an
offline Entity (a Runtime that is down: chain.qnt `offline`), `SetCredit`, swaps. The J batch is jbatch.qnt; several inputs per frame
are E1.

**E3. The deadline arithmetic, derived. CLOSED.**
Let LAG be the ticks a J transaction needs to be included, and the ticks a J event needs to reach the Entity. A payee that knows
a secret only off-chain must put it on the chain by the deadline, so it starts a dispute at deadline - ESC with ESC >= LAG
(`escalation-too-late`: escalating at the deadline puts the secret there one tick late). An onward lock must end HOP before the
inbound one: peer 2 may resolve at the last tick of its lock, the hub learns it then, and needs ESC ticks after that
(HOP >= ESC; `forward-deadline-equal` and its consequence test show the loss with HOP = 0). The model also passes with HOP = 1 =
LAG (chain.REACT was 0 then). Since C11 REACT = 2 * LAG and `params_test.qnt` requires HOP >= REACT. The spec value is **HOP = 2 = 2 * LAG**: one tick of slack for the Entity's reaction, which the model sets to zero. The
inequalities are the rule; the numbers are deployment parameters. Decision: HOP = 2 * LAG is a named policy parameter, not a
protocol constant. Source: R-P2, R-P3.

**E4. When a forwarded route may be failed back. CLOSED.**
Not when the onward deadline passes: peer 2 may have put the secret on the chain by then (inclusion time <= deadline) and the
Entity reads the event up to LAG later. The route fails back when the onward lock is gone from a signed state (a newer proof
without it beats any older one), or when the deadline + LAG has passed with the secret still unknown, and never while the secret
is known (that is a claim, not a failure). `failback-without-lag` with `lateRevealCannotBeMissedTest`. Decision: the hub waits one LAG after the onward deadline before it fails back.

**E5. What a dispute carries, and until when. CLOSED.**
Every known secret that opens a payee clause of the proof the Entity stands on: at the start, and again in every later frame
for a secret learned afterwards (`publishFor`, one rule with two moments). The proof it stands on is its tip when it reads the
dispute (its own start or the peer's). `publish-first-slot-only` shows the loss (the second route's secret is not on the chain).
Decision: every known payee secret goes into a dispute. Source: #37, R-P3.

**E6. What the model needs from the chain (an interface, not a proof). CLOSED on the chain side.**
A clause pays its payee iff its secret is on the chain by the clause's deadline and the proof holding the clause is the one the
dispute settles; a secret on the chain pays nobody by itself (there must be a dispute on that Account whose proof holds the
clause); starting the dispute after the deadline still pays a clause whose secret was revealed in time. chain.qnt has the first
two (`revealedClausePaysTest`, `lateSecretPaysNothingTest`); the third is `lateStartStillPaysARevealedClauseTest` (a hub fixture: the
payee reveals, four ticks pass, the starter starts with the older proof; finalize pays the payee 3, no debt), with the mutant
`reveal-counts-only-if-start-in-time` killed by it. Decision (coordinator, 18:15Z): the contracts pin the same fact on the real contracts
(`contracts/test/vm/h1-htlc-deadline.test.ts`, #47): a secret revealed before the deadline is paid at finalize even when the dispute
starts after it; one revealed after is not. Entity and chain are composed at four points, each checked: (1) the interface above, in
`chain_test.qnt`; (2) one set of numbers, `params_test.qnt` (LAG, REACT = 2 * LAG, DWIN = 2 * MIN_WINDOW, HOP >= REACT, ESC >= LAG);
(3) the answer's timing: the chain forces the honest side only REACT ticks after an event (C11) and the Entity's answer lands
inside the windows (`answer_in_window`); (4) the entity's deadline arithmetic played on the real dispute game
(`hopMarginPaysTheHubTest`, `noMarginLosesTheHubTest`). One state machine with both would only re-check (1) to (4) with more
states: the chain's state is one Account and the Entity's is two, so a joint model needs the Account histories of the real
frames (the next item, "account + chain").

**E7. A route slot is not a private namespace. CLOSED (2026-09-29).**
The inbound slot number and the onward slot number are unrelated: peer 2 may hold OUT slot 1 with a lock of its own, and a command of
ours may have one in flight. The route (per inbound slot k) carries its own OUT slot `os`: the lowest slot that is free on the planning
view (committed, in flight, queued) and that no route which is not over holds (`freeOutSlot`). None free: the inbound lock fails back
at once. A route keeps its slot until both locks are gone and nothing is queued for it (`resetOne`), and the ghost record of what
peer 2 did with the lock is kept per OUT slot. Options: (a) reuse k (the first model; refused whenever the slot is taken), (b) pick
the free slot (chosen; a forward is refused only for lack of credit or of a free slot). Tests `onwardSlotIsTheLowestFreeOneTest`,
`twoForwardsInOneFrameUseTwoSlotsTest`, `slotStaysReservedUntilTheRouteIsOverTest`, `peerHoldsTheLowSlotTest`,
`ownLockInFlightHoldsTheLowSlotTest`; mutants `fixed-out-slot`, `free-slot-ignores-the-plan`, `free-slot-ignores-reservations`.

**E8. Commands.**
A signed command names one or more Accounts. It applies to all of them or to none (the nonce is spent only when it applies), it is
admitted against the planning view (tip, our frame in flight, our queue) and a replayed nonce is refused without effect
[Q-E2, Q-E1]. Hooks' own transactions bypass the queue cap (they are the protocol, not a user).

**E9. Collisions as the Entity lives them.**
Left ignores the peer's frame and keeps its own in flight; Right puts its frame back at the front of its queue and applies the
peer's [R-A1]. `rightRollsBackOnCollisionTest`, `leftKeepsItsFrameOnCollisionTest`.

**E10. A refused peer frame is a value.** It counts and changes nothing; it never halts [R-X1] (`halt-on-refusal`).

**E12. Our start lands beside the peer's: DisputeOpSkipped. CLOSED.**
We send a dispute start; the peer's start reaches the chain first. There is one dispute per Account, so ours is skipped and the chain
emits `DisputeOpSkipped` (J2). What the Entity does: (1) until it reads the outcome of its own start it is `await`ing; the outcome is
either DisputeStarted (ours landed) or DisputeOpSkipped (ours was skipped); (2) the peer's DisputeStarted, which comes first in chain
order, is answered as any peer dispute is: freeze, name the tip, publish every known secret; (3) the skip ends the wait, the open
dispute is not ours (`byUs` false) and, if the peer's event was not read yet, the skip answers it too (the same answer twice is one
answer). Counter after the window closed: the Entity's answer is late, which `answer_in_window` already flags (C11); the skip event
then only tells it not to send the counter again. Options for (1): treat the next DisputeStarted on the Account as the outcome of our
start (rejected: it would swallow the peer's dispute; the starter is in the event). Model: `ownStartLands`, `peerStartsBeside`, events
`JStarted` and `JSkip`, property `skip_ends_the_wait`, tests `ownStartLandsIsReadTest`, `skippedStartEndsTheWaitAndAnswersTheOpenOneTest`,
`skipAloneAnswersTheOpenDisputeTest`, mutants `skip-outcome-not-read` and `skip-read-as-started`. The race needs an escalation and three more steps: the random simulation reaches
it only on some seeds (seed 1 kills `skip-outcome-not-read` by the invariant, seed 7 does not reach it in 3000 traces), so the witness
`w_no_outcome` covers the landed start and the scenario tests cover the skip.

**C12. Several clauses in one Account: what the single-clause chain model leaves out. CLOSED by a check.**
The Account layer allows up to LOCK_SLOTS open clauses, `chain.qnt` holds one per proof. The contract (`DeltaTransformer._applyBatch`) settles
the payments one by one, each adds its amount to the delta when its secret is on the chain by its deadline, independently of the others; a
clause that is still open and unrevealed makes the whole finalize revert until its deadline has passed (H1), so a finalize waits for the
latest unrevealed deadline. So the clauses interact in two places only: the wait (the maximum, not each) and the sum, which the payout then
clamps to the collateral with the rest as debt. The sum is the risk: two clauses that are each fine alone can together push a side
outside its credit. `compose.qnt` checks it exhaustively over a small domain (offdelta -4..6, limits 0..2, two slots each empty or a
clause of either payer with amount 1..3): for every Body that satisfies RCPAN and every subset of resolved clauses, the chain's `payout`
leaves no side owing more than the credit it was granted and pays out exactly the collateral. Non-vacuous: the domain has Bodies with two
open clauses and with debt, and RCPAN without the open clauses (`weakRcpan`) is violated. Mutants: `rcpan-ignores-open-clauses`,
`payout-forgets-the-debt`, `payout-pays-the-collateral-twice`. Not covered: a wait that differs per clause in the chain model itself (the
single clause has one deadline); the maximum-of-deadlines is the contract's line, stated here and checked by `finalizeWaitsForDeadlineTest`
for one clause.

**C13. R-IMPLICIT-BASELINE: the empty state of an epoch is a dispute proof with no signature (coordinator 09-30, decision D2; plan/contracts-decisions.md).**
From ondelta epoch 1 a dispute may start from the IMPLICIT proof: empty signature, and a body the chain knows entirely from its own state (`implicitProof`): the
epoch of the Account, nonce stored + 1, authored by Right, offdelta 0, no clause, both windows exactly the floor `MIN_WINDOW`; no starter arguments and no counter-proof commitment.
It needs no signature and no arena slot, and settles at Delta = ondelta. Any signed frame of the epoch outranks it through a counter, with one exception that the rank rule produces
(A12: rank = 2 * nonce + (Left ? 1 : 0)): at nonce stored + 1 a Left-authored frame outranks the implicit proof (`leftAuthoredFrameOutranksImplicitTest`) and a Right-authored one only TIES
it, and a tie is a refused counter (`rightAuthoredFrameAtStoredPlusOneTiesAndIsRefusedTest`). **The trap:** after a settlement (stored 2) Right signs the first frame of the epoch at 3
with offdelta +2, opens the implicit dispute at 3, Left's counter ties and is refused, and at the timeout Delta = ondelta: Left's 2 is lost (`theTrapLosesTheFramesValueTest` asserts
the payout and that `p1_allowed` flags it). **The rule that closes it, for the Runtime and the specs: the first signed proof of a new epoch takes nonce >= stored + 2**, with the stored nonce READ from the
chain; at stored + 2 the same Right-authored frame counters (`rightAuthoredFrameAtStoredPlusTwoCountersTest`). In `chain.qnt` the arena's epoch-1 frames sit at nonces 7 and 8, above stored + 2 for every nonce epoch 1 can open at (2 to 5);
in `settle.qnt` the rule is `FIRST_GAP`, enforced by the honest side as author and as acker and judged by the ghost `firstLow` / property `first_proof_at_stored_plus_two`.
Windows (counter and final) may LENGTHEN but never shorten inside an epoch (the contract refuses a body that shortens them, E9); the clock stays frozen from the initial body. This replaces N3's
"one set of windows" (`windows_frozen`) by `windows_never_shortened`; an implicit start names the floor, so a signed counter must be allowed to carry longer windows.
A deposit (reserve to collateral) does NOT advance the epoch (only a dispute finalize, a co-signed collateral-to-reserve withdrawal and a settlement do): every signed frame of the epoch
stays valid, and an implicit dispute started after a deposit settles at the NEW ondelta (`depositInsideTheEpochKeepsTheFramesTest`, `depositThenImplicitSettlesAtTheNewOndeltaTest`).
Epoch 0 has no implicit proof (`epoch0RefusesAnImplicitStartTest`): a fresh Account's first frames are its proofs. Two disputes in a row each have a proof (`twoImplicitDisputesInARowTest`).
Single token: the contract's starter names the tokens of an implicit start (a token it omits keeps its collateral); that needs multi-token Accounts and is v2 (V2.md).
Not modelled: that the non-starter reads the implicit body from the start calldata (the event carries only the hash): a J-watcher duty of the Entity/Runtime layers. The honest side's counter
needs windows at least the dispute's; `honestCounterId` does not check it, so a tip with shorter windows than an implicit start's leaves time stopped rather than a visible loss (the Runtime never signs below the floor).
Mutants: see `mutants/chain.json` (`implicit-*`, `r-windows-never-shorten-*`, `deposit-advances-the-epoch`) and `mutants/settle.json` (`first-proof-*`, `acker-signs-first-proof-*`).

**E11. Found while writing it.**
(a) The first version treated any lock in OUT slot k as the onward lock: peer 2's own lock in that slot broke `deadline_chain`
(E7). (b) A secret on the chain pays nobody without a dispute holding the clause; the first `route_safe` treated it as payment and
called a correct fail back a loss. Both were the model being wrong, not the Entity.

---

# The J batch (jbatch.qnt)

One Entity, one token, four ops (a payment, a secret reveal, a dispute step, another payment). The chain facts are read from
`contracts/contracts/Depository.sol` `processBatch` / `_processBatch`: a batch is signed for an entity and a nonce and lands only at
`nonce = stored + 1`; a reverting op reverts all of it; a signed batch never expires and anybody can submit it, again, later. The
honest relayer submits every batch in ascending nonce order and each first attempt happens within LAG; the adversary picks which batch
of one nonce lands (when the Entity signed several), spoils dispute ops (`poison`), moves the reserve and re-submits anything ever signed.
Simulation only.

**J1. What a lost, reverted or dropped batch does (Q-J1). CLOSED.**
A batch that reverts leaves nothing on the chain, and it stays valid: the reserve and collateral it names are untouched, and it can be
sent again by anyone, at any time (`resubmittedBatchIsHarmlessTest`: the second landing is refused by the nonce, E2, and runs nothing;
`chain-accepts-old-nonces` shows the double payment otherwise, property `pay_once`). So the Entity's latches are Entity-side bookkeeping
with one rule: a latch is released only when a batch carrying the op has landed, or the op can never apply (its dispute moved, seen as
a DisputeOpSkipped). Never on a timeout: `drop-every-op-of-a-failed-batch` (property `dropped_only_dead`) abandons a payment whose
signed batch then lands later. A payment failed at its nonce (J5) is queued again and signed at a fresh nonce
(`revertedPaymentDoesNotBlockTheUrgentOpTest`). Source: Q-J1.

**J2. A dispute op that cannot apply: revert the batch or skip the op? ACCEPTED (TOLERANT); the contracts thread changes it test-first.**
Today one dispute start over a dispute that moved (the adversary finalized first, a counter already registered) reverts the whole
batch, and the secret reveal in the same batch is lost with it. Options: (a) as is; (b) dispute-class ops (start, counter, finalize,
reveal) skip when they cannot apply or already ran, and emit an event; payments, deposits and settlements keep reverting; (c) as (a) and
the Entity puts every urgent op in a batch of its own. Choice: (b). With (a) an urgent op cannot be bound by LAG: every spoiled op
costs a round (`contract-reverts-on-moved-dispute`), with (c) k urgent ops cost k rounds. This is a contract change for the
contracts thread; until it lands the spec's deadline numbers need `(k + 1) * LAG` where k is the number of concurrent urgent ops.
Also required: an urgent op that already ran is skipped when it appears again (a batch that is sent again).
**The event (coordinator, 2026-09-29, built in the contracts).** A skipped dispute op emits
`DisputeOpSkipped(sender, counterentity, op, reason, nonce)`. The reasons the spec covers: a start beside an open dispute (there is at
most one dispute per Account), a counter after the window closed, an op that already ran. The event is a chain fact like any other:
the Entity that sent the op learns from it that the op is dead and abandons it (`skip_read`, mutant `entity-ignores-the-skip-event`);
without it the node waits for an outcome (a DisputeStarted) that never comes. The Runtime must read it (R7) and the Entity must
act on it (E12).

**J3. How the Entity signs urgent ops. CLOSED (given J2, J5 and F1).**
(1) An urgent op (a reveal or a dispute step) never rides with a payment: a payment that cannot run (reserve moved) would take it
down (`pack-everything`, `urgent-batch-carries-payments`). (2) Each urgent op that is in no live batch gets one batch of its own, at a
fresh nonce (F1). (3) Payments wait until nothing is live (`urgent-waits-for-outstanding` shows the price of also making urgent ops
wait). With J2, J5 and F1 an urgent op lands within LAG of reaching the Entity, which is the LAG the deadline arithmetic of the
Entity layer uses (`params_test.qnt` pins jbatch.LAG = entity.LAG). The first version of this rule signed a pair of batches, the
first at a nonce a live payment batch also held; the simulation found that an older batch signed for a nonce burns the fresh one's
nonce. F1 replaces the pair.

**F1. A signed batch is final at its nonce (coordinator, from the J2 review). CLOSED.**
`processBatch` is permissionless: anybody may send any signed batch, at any time. With J2 a batch whose ops are all stale lands as a
no-op and still takes its entity nonce. So the rule is: never sign different content at a nonce you have already signed, and always
send a replacement at a fresh nonce (above every nonce signed so far, `topSigned`). An abandoned batch costs nothing when the fresh
ones sit above it: it lands as a no-op in the same round and the ones above it land right behind it. Property `nonce_final` (no two signed
batches with one nonce and different content); mutant `resign-at-a-signed-nonce` (the fresh nonce ignores what is signed) shows the
burn. Test `neverTwoBatchesForOneNonceTest`.

**F2. After an abort only urgent ops go back at once (coordinator rule, 2026-09-29). CLOSED.**
The Entity may give a signed draft up (a rolled-back frame, a restart that lost the outbox), but the signed batch is not recalled and
can still land (F1: it never expires). A dispute step, secret reveal or hash-ladder op runs once or is skipped (J2), so it goes back into
the draft at once at a fresh nonce; if both copies land it has still run once (`abortedRevealIsSignedAtOnceTest`). A payment, a deposit
or a reserve move runs every time its batch lands, so it goes back only after the abandoned batch's nonce is used, and after the Entity
has read `BatchFailed` if the batch failed (`inFlight` and `nothingAlive` keep counting an abandoned batch for those ops:
`PAY_HELD_AFTER_ABORT`). The model has one op kind for all three (`Pay`: R-SPLIT groups payments, settlements and reserve moves as the
ones a failed batch does not touch); deposits and reserve moves are the same as payments for this rule, and the mutant
`abort-requeues-payments-at-once` (the abandoned batch and its replacement both land) violates `pay_once`. Tests
`abortedPaymentIsNotSignedAgainTest`, `abortedPaymentWaitsForBatchFailedTest`. The Entity layer models no deposit op of its own; the
rule lives in the J batch layer where the ops are queued.

**J5. A batch that fails still takes its nonce. ACCEPTED (b) by the coordinator (2026-09-29); the contracts thread builds it test-first.**
Today a batch that reverts (a payment the reserve cannot cover) leaves no trace, its nonce stays open, and every batch above it waits.
F1 forbids signing another content at that nonce, so with the contract as it is a drained reserve holds every urgent op hostage until
somebody refills it: `payment-revert-keeps-the-nonce` violates `urgent_lands` (found by simulation the moment F1 went in). Options:
(a) as is, and the Entity tops up the reserve on reading a failed payment (an external deposit takes no entity nonce): the urgent op
waits REACT + LAG, not LAG; (b) **a batch that fails takes its nonce, applies nothing and emits `BatchFailed(entity, nonce, reason)`**
(Ethereum's own rule for a failed transaction): nothing is ever blocked, the payment is queued and signed again at a fresh nonce;
(c) payment ops skip like dispute ops (rejected: it makes a batch non-atomic, and a settlement that pays half is worse than one that
does not run). Choice: (b). It is a small change in `processBatch` (catch the failure, keep the nonce, revert the effects). Until it
lands the deadline numbers of the Entity layer need option (a)'s bound. The Entity reads BatchFailed like DisputeOpSkipped (R7).
Decision: (b), for a failing payment or settlement op; (c) is rejected. The whole transaction must succeed: the failure is caught, its effects
are undone, the nonce is stored and `BatchFailed` is emitted. A failure that reverts the transaction itself loses the nonce write and the nonce stays open
(that is today's contract: `payment-revert-keeps-the-nonce`). The Entity reads `BatchFailed` and queues the payment again at a fresh nonce; it does
not sign it again before it has read the event (`failed_read`, mutant `entity-ignores-batch-failed`). Tests: `revertedPaymentDoesNotBlockTheUrgentOpTest`.
Model: `NONCE_ON_FAIL`, `failedEv`, `failSeen`; `urgent_lands` holds under it.
**As built (coordinator, 2026-09-29).** Two limits that the spec now carries.
**R-SPLIT.** Only a batch with no dispute, reveal or hash-ladder op gets the BatchFailed treatment (applies nothing, takes its nonce).
A mixed batch that fails still reverts whole and keeps its nonce open. So the Entity's rule: dispute, reveal and hash-ladder ops never share a
batch with payment, settlement or reserve ops. This was already J3(1); it is now also the chain's line: `urgent-batch-carries-payments`
(the Entity mixes them) breaks `urgent_lands` because the failed mixed batch reverts, loses the urgent op and holds every batch above it.
**Gas guard (now a floor; replaced by the signed budget, J7).** A batch failure is reported only when the self-call got at least `BATCH_GAS_FLOOR`; below it the transaction reverts and takes no nonce, so a relayer cannot burn a good batch by starving the call. (Was: under 1/32 of the gas.) Model: `starve` (a relayer call with too little gas), `GAS_GUARD`, property `no_burn`; mutant `no-gas-guard`
burns a payment batch that would have applied (`starvedBatchLandsLaterTest`). The starved call of an urgent batch only reverts whole, which
leaves the batch valid for the honest relayer's next attempt.
**Refinement (coordinator, from the #54 review, 2026-09-29).** Two rules. (1) A batch that carries a deposit leg (`externalTokenToReserve`) reverts whole, like a
dispute batch, and never soft-fails: a paused token or a moved allowance cannot burn its nonce (`DEP_SOFT_FAILS = false`; mutant `deposit-batch-soft-fails`;
`failedDepositBatchRevertsWholeTest`; property `dep_never_burns`). The deposit legs run first, so a deposit funds the payment behind it; the Entity lets a deposit go alone
in its batch (`depositFundsThePaymentBehindItTest`), so a failing deposit cannot take a payment down with it. (2) A bad counterparty signature inside a batch is a
soft fail: a settlement or C2R signed at an old account epoch (`Settle`, `poison`) takes the nonce, applies nothing and emits BatchFailed; the Entity drops it, because it needs
a fresh co-signature, which is a new op (`staleSettlementFailsSoftTest`, mutant `bad-cp-signature-reverts`). Only a failure of the batch's own hanko authorisation reverts
without taking the nonce (`forge`, `forgedBatchTakesNoNonceTest`; mutants `forged-batch-lands`, `bad-auth-takes-the-nonce`). The relayer that submits out of order is `attemptAny`
(`outOfOrderRelayerIsRefusedTest`; mutant `chain-accepts-nonce-above-stored`, caught by `nonce_sequential`).
**J2 extended, R-COSIGN, gas stipend (coordinator, second #54 review, 2026-09-29).** (1) Any dispute, reveal or hash-ladder op whose precondition can never hold again (a
finalize after a counter landed, a start beside an open dispute) skips with `DisputeOpSkipped` and the batch consumes its nonce; a transient failure (a finalize before its
window ends) still reverts the batch whole and leaves the nonce open. The model has the first (`poison`, TOLERANT); it does not model a transient failure of an urgent op, so the
Entity rule that follows is written here and not checked: an urgent op is signed only when its precondition holds by the Entity's own clock plus `LAG` (else the batch would
hold the nonce). (2) **R-COSIGN**: a batch that carries a co-signed op (a settlement or C2R) carries only ops for that one Account: a counterparty's state change or a
relayer's gas choice can fail such a batch, so nothing unrelated may ride with it (`cosign_alone`; `coSignedOpsTravelAloneTest`, `coSignedOpsOfTwoAccountsDoNotShareABatchTest`;
mutants `cosign-batch-carries-payments`, `cosign-batch-mixes-accounts`). (3) Gas (superseded, coordinator 2026-09-30: the ERC-1271 stipend is dropped for a floor): a batch failure is reported (`BatchFailed`, nonce spent) only when the self-call got at
least `BATCH_GAS_FLOOR`; below it the transaction reverts and takes no nonce; at or above it an empty revert reason is `BatchFailed(0)` and spends the nonce. That is the model's `starve` with the guard
(`starvedBatchLandsLaterTest`, `no_burn`, mutant `no-gas-guard`); gas starvation is a hard revert, never `BatchFailed`.
**J6. The cost of revert-whole for deposits. ACCEPTED with rules (coordinator, 2026-09-30).** A deposit batch that cannot land keeps its nonce open, so every batch above it waits, an urgent op
included (`stuckDepositBatchHoldsAnUrgentOpTest`: the reveal misses its deadline; the model records it as `hostage`, apart from `missed`, because no Entity behaviour can help). The contract has no
direct deposit path and adding a permissionless one was refused, so deposit legs stay in signed batches, under three rules: (1) a deposit leg travels alone in its batch
(`depositFundsThePaymentBehindItTest`); (2) the Runtime signs a deposit batch only after simulating it successfully (`SIMULATE_DEPOSITS`, `depositIsNotSignedWhileTheTokenIsPausedTest`, mutant
`deposit-signed-without-simulation`); (3) a token paused between the simulation and the landing stalls the nonce, a residual risk that is accepted. No simulation witness reaches it (the sequence is too specific);
the scenario test is the evidence.
**J4. Nonces: what the contract's strict sequence costs.**
Any signed batch is a nonce burner in the adversary's hands (F1), and a payment batch that reverts blocks every batch above it (E2, J5).
Options: (a) keep the strict sequence (F1 and J5 work around it), (b) unordered nonces with revocation. Choice: (a) for v1. (b) removes
the burn and the hostage chain but needs a revocation batch before an op is re-signed, and the double-run hazard for payments returns. The batch limits
of R-J3 (`MAX_ENCODED_BATCH_BYTES`, per-array bounds) are not modelled: a full batch is a refusal, as in R-J3.

---

# The Runtime (runtime.qnt)

The Entity is abstracted to its input history (the keys of the inputs it applied, in order); the signed frame it sends is
`(height, history)`. Two different histories at one height are an equivocation. Inputs: chain events (key k), peer messages
(10 + k), commands (20 + k). One frame is three steps, apply in memory, make it durable, send; a crash and restart can happen
between any two. Simulation only.

**R1. The order of a frame (R-R1). CLOSED.**
A frame applies the inputs due at its tick as one batch in ascending key order: the peer's messages, then chain events, then
commands, whatever order they arrived in (peers first: a frame co-signed at the tick a dispute is read is in the evidence, E1). `frame-in-arrival-order` (property `canonical_frames`), `canonicalOrderTest`. A frame opens
only when an input is due (the idle gate): `empty-frame`, `noFrameWithoutInputTest`. Canonical order is the spec's choice; the
Entity's own order inside the frame (input, hooks, command, propose) is entity.qnt's and is a separate rule [R-E1].

**R2. J watching: exactly once, in order (R-J1). CLOSED.**
The watcher offers the event after the cursor, again and again until it is applied. The cursor moves with the frame that applies the
event, in the same durable write, and nowhere else: `cursor-moves-when-read` loses an event after a crash, `cursor-not-with-state` leaves
the cursor behind the history, `no-dedupe` applies an input twice (`exactly_once_j`, `chainEventSurvivesACrashTest`). A gap in the
event sequence is not something the Runtime can repair: see R5.

**R3. Durable before it leaves. CLOSED.**
(1) A signed frame is sent only after the state that produced it is durable: with the frame in flight a crash throws away memory, the
restart derives the next frame from different inputs, and the Entity has signed two frames for one height. The counterparty then holds
proof of it (`send-before-persist`, property `no_equivocation`). (2) A command is acknowledged to its user only once durable
(`ack-before-persist`, `acked_durable`). (3) On restart the last signed frame is sent again, and it is the same frame
(`crashAfterDurableResendsTest`); peer messages and commands that were only in memory are resent or resubmitted by their senders
(assumption: a peer resends until acked, which account.qnt models; a command is resubmitted by its user until acknowledged).

**R4. Time.**
The Runtime's clock is an input: a frame carries the timestamp the Runtime committed for it, never a wall-clock read inside the
Entity, so replaying the log reproduces the state [R-R1]. entity.qnt takes `now` from the input and advances it only when the Entity
is quiescent, which is this assumption stated for the Entity (zero reaction time; the deployment number is "processing under one tick").

**R5. The halt taxonomy (R-X1, Q-R1). CLOSED, a closed list.**
A halt stops one Entity and is reported; nothing else stops. The list of causes, all local:
(a) a durable write fails (the Runtime cannot keep R3, so it stops instead of sending);
(b) the durable state does not load or does not verify at restart;
(c) an invariant of the Entity's own state breaks after a frame (a bug: a balance below its bound, a lock that cannot be resolved);
(d) the two replicas of one board disagree on the state hash of a frame they both applied (a fork of our own doing);
(e) the chain event sequence has a gap the watcher cannot fill (R2).
Everything a peer can cause is a refusal: a malformed or badly signed frame, a stale or future nonce, an unknown Account, a full
batch (R-J3), a command over a limit. A refusal is a value: counted, no state change, optionally answered, never a halt
(`halt-on-refusal` in entity.qnt kills the opposite). The og engine has 8 halts that a peer can trigger; none of them is on this list.

**R7. Every kind of chain event is read. CLOSED.**
The watcher does not choose which events to read: the cursor moves over every event of the Depository log for the Entity's Accounts,
DisputeOpSkipped (J2) included. A watcher that reads only the kinds it thinks the Entity waits for leaves a node whose start was
skipped waiting for a DisputeStarted that never comes (`watcher-skips-the-skip-event`, `skipEventIsReadInOrderTest`). The event is
applied in order with the others, exactly once, across crashes (R2), and the frame that applies it moves the cursor.

**R6. Not modelled here.** Several Entities in one Runtime (they share nothing but the process: the properties are per Entity),
the board's own consensus (v2: boards), the network beyond "a peer resends until acked", storage cost, and the offline Entity: a
Runtime that is down misses windows, which chain.qnt models as `offline` (the honest party can lose).

**J6a. NAMED DECISION: a token failure in a deposit leg is a hard revert and takes no nonce (`DEP_SOFT_FAILS = false`) (coordinator, 2026-09-30).** The rule "once the budget is given,
every failure is `BatchFailed` with the nonce spent" covers gas failures (J7) and every non-deposit op. It does not reach a token failure inside a deposit leg. Reason: a deposit
pulls the tokens from `msg.sender`, the relayer. If a token failure spent the nonce, a relayer with no allowance (or one that submits while the token is paused) could burn the
Entity's nonce at will, which is the original #54 bug. So a batch with a deposit leg that fails on the token reverts whole and leaves its nonce open. The cost is the J6 stall (a token
paused after the signing holds every batch above it, urgent ops included), which stays accepted. This is a decision, not an oversight: `dep_never_burns`, mutant `deposit-batch-soft-fails`,
`failedDepositBatchRevertsWholeTest`. A gas failure inside a deposit batch is different (J7 (2)): the budget was given, so it spends the nonce like any other.

**J6b. Decision (final review F8, coordinator 2026-09-30): a deposit that cannot be signed now is skipped, not waited for.** While the token is paused the Runtime does not sign the deposit
(J6 rule 2), and it no longer holds the payments queued behind it either: `plan` falls through to the payment branches with the deposit leg removed, so the payments go out
alone (rule 1, a deposit travels alone, is kept) and only the deposit stalls; it is signed at the next nonce once the token works and nothing is outstanding. Before, an `else if`
returned no batch at all, so a paused token froze the whole Entity (and, with one nonce per Entity, other tokens' payments) with no timeout. `paymentGoesOutBehindAPausedDepositTest`;
mutant `payments-wait-behind-a-paused-deposit`. J6a and J6 cover a different case (the nonce stall after signing).

**J6c. Decision (final review F12, F14; coordinator 2026-09-30): the planner signs a payment only if the reserve covers it, always.** J6b let every payment behind a skipped
deposit go out. With the token paused and reserve 0 that signs a payment the deposit was meant to fund: it fails soft (J5), takes its nonce, and is signed again every round, burning a nonce each time. F14 made this
the general rule (R-SIMULATE: a payment the simulation would fail is not signed), not only a rule for a skipped deposit: after a drain the same loop appeared with no deposit in sight. `plan` takes the payment legs the reserve
covers, oldest first, skipping one that does not fit (`payTotal <= s.reserve`, walked in id order, so a later, smaller payment can go out while an earlier one waits); the rest wait for a refill, and a deposit goes first when
the token works, funding them. Property `no_unfunded_signed` (ghost `unfunded`, set in `submit`); the two tests that rode the old loop now expect "not signed again until the refill"; mutant `unfunded-payment-is-signed`.
`paymentGoesOutBehindAPausedDepositTest` (reserve 3) still shows a covered payment going out.

**J7. Signed gas budget, gates, the gas cap, the epoch on a dispute start (coordinator, 2026-09-30). Modelled; one choice for the coordinator.**
(1) **Budget replaces the floor.** The signer sets each batch's gas budget from its own simulation and it is inside the signed bytes. A relayer that supplies less reverts the
transaction and takes no nonce (`starve`, `underBudgetRelayerTakesNoNonceTest`, `no_burn`, mutant `no-gas-guard`). Once the budget is given, a **money-only** batch (payments, settlements, reserve ops) that
fails inside it is `BatchFailed` with the nonce spent, out-of-gas and gas-burning callees included: `gasFail` (`gasFailInsideTheBudgetSpendsTheNonceTest`, mutants `gas-fail-keeps-the-nonce`, `gas-fail-not-read`).
The Entity reads the event and signs what is still owed at a fresh nonce.
(2) **F16, contract as built (reviewer, coordinator 2026-09-30; replaces an earlier confirmation that every failure is soft).** A batch with a dispute, reveal, hash-ladder or deposit op runs in
`processBatch`'s own frame, so running out of gas there reverts the whole transaction and leaves the nonce unspent, exactly like an under-budget relayer (`starve`); only money-only batches take the soft
path (`BatchGasStarved` / `BatchFailed`). That is the intended design: time-critical dispute ops must be resubmittable, not burned, and a deposit leg hard-reverts (J6, J6a). `gasFail` is guarded to
money-only batches without a deposit leg; `gasFailOnAnUrgentBatchRevertsWholeAndKeepsTheNonceTest`, `outOfGasInAnUrgentBatchIsResubmittedAtTheSameNonceTest`, `gasFailOnADepositBatchIsNotBatchFailedTest`;
mutants `gas-fail-burns-an-urgent-batch`, `gas-fail-burns-a-deposit-batch`. A token that stops working after signing (J6) still reverts the deposit batch whole and keeps the nonce; see J6a.
(3) **The `gasMissed` residual is gone.** It recorded an urgent op whose batch was burnt by a gas failure and then missed its deadline on the retry; with (2) an urgent batch never burns its nonce that
way, so the ghost (`gasMissed`, `burnt`) and the witness `w_no_gas_missed` are removed. What remains of the token residual is `hostage` and J6 (a deposit batch that cannot land holds the nonce), recorded apart
from `missed`. `GAS_FAILS_MAX = 1` per run bounds the money-only case.
(4) **Runtime rules, written and checked.** Sign a batch only after simulating it successfully at the head (deposit legs: `SIMULATE_DEPOSITS`; gated ops below). Never sign a time-gated op before its
gate opens: ops carry `gate`, a dispute finalize's is the end of its window; `RESPECT_GATE`, property `gate_respected`, `gatedOpIsNotSignedBeforeItsGateTest`, `earlyGatedBatchRevertsTest` (the chain reverts an
early gated batch and keeps the nonce), mutants `signs-before-gate`, `chain-ignores-the-gate`. Split any batch above the chain's tx gas cap: a settlement costs two units, everything else one,
`TX_GAS_CAP = 2`; a batch above it can never land, the transaction itself runs out so the failure cannot be caught and takes no nonce (`overCapBatchNeverLandsTest`, mutants `over-cap-batch-lands`,
`over-cap-batch-soft-fails`); `firstChunk` splits, property `within_cap`. **Limit, stated plainly:** with four ops the Entity's other rules (deposit alone, R-COSIGN) already keep every batch under the cap,
so `SPLIT_AT_CAP` is not exercised by the search; the tests inject an over-cap batch to show what the chain does with it.
(5) **Dispute start carries `ondeltaEpoch`** and is skipped on a mismatch (chain.qnt `startAtDeadEpoch`, ghost `staleSkips`, `deadEpochStartIsSkippedTest`, mutant `dead-epoch-start-applies`). The proof's own
epoch is still checked (C1); the op-level epoch is the same fact where the Entity can read it as a skip. It is a stutter on chain state by design: nothing moves, the nonce stays.

**C-debt. Debt is enforced before an outflow (final review, carried from the first review; closed 2026-09-30).** `Depository._enforceDebts` runs before R2R, R2C, R2E and `_settleShortfall`, and spendable reserve is
reserve net of outstanding debt. Two chain mutants survived for two rounds because every property is stated on net worth, and enforcing a debt moves nothing in net worth. They are killed now:
`shortfall-skips-enforce` by `olderDebtIsEnforcedBeforeAShortfallTest` (Left owes 1 and holds 2, then a payout leaves it 3 short: with enforcement Left ends with 0 and owes 2, without it Left keeps 1 and owes 3)
and by the new ghost and property `debt_means_broke` (after a payout that leaves debt the debtor holds no reserve); `spendable-ignores-debt` by `spendableIsReserveNetOfDebtTest`, which pins the helper to the contract's
definition. **Stated plainly:** the second is behaviourally equivalent inside the model, because `spendable` is only ever read on money that `enforce` has just cleaned (after enforcement the spendable reserve is the reserve), so
the test pins the helper and not an outcome; `reserveThatIsOwedCannotBeDepositedTest` shows the outcome (a side whose whole reserve is owed cannot deposit it).
**The 32-claim bound (coordinator, 2026-09-30).** `_enforceDebts` pays at most 32 queued claims a call, oldest first, so `debt_means_broke` as first written (after a payout that leaves debt the debtor holds no reserve)
was stronger than the contract. The model now keeps the queue (`Money.dq`, oldest first; `debt` stays the total, `debt_queue_sums`) and scales the bound down to `DEBT_ENFORCE_MAX = 2` so a search meets a queue longer
than one call clears (`init` draws up to three claims; witness `w_no_long_queue`; `w_no_older_debt`, F13). What the contract keeps, and what `debt_means_broke` now states: spendable reserve nets ALL outstanding debt, the
unreached tail included (`spendable`), so after a payout that leaves debt nothing is spendable; and a debtor is broke (no reserve at all) once its queue fits in one call. With a longer queue reserve may remain, all of it owed
(`enforcementReachesOnlyOneCallsWorthOfClaimsTest`; mutants `enforce-has-no-call-bound`, `spendable-ignores-the-queue-tail`). A part-paid claim stays at the head with what is left: **checked** against `contracts/contracts/Account.sol` `enforceDebts` (the `else` branch stores the remainder and leaves `cursor`
where it is; only a fully paid claim advances it).
**F15 (final review, coordinator 2026-09-30): a deposit enforces first.** `Depository._reserveToCollateral` runs `_enforceDebts` before it moves reserve, so a depositor whose queue fitted in one call owes nothing after
the deposit, and what a longer queue leaves is owed and cannot be deposited: property `r2c_enforces_first` (ghost `r2cOwes`), tests `depositPaysTheOlderDebtFirstTest` and `longQueueReserveCannotBeDepositedTest`,
mutants `r2c-skips-enforce` and `r2c-ignores-debt`.
**Modelled out, and unable to break `debt_means_broke`:** the public `Depository.enforceDebts(entity, token, maxIterations)`, callable by anyone; `maxIterations = 0` means no cap and drains the whole queue. It only
moves reserve from a debtor to its creditors in queue order, which is what `enforce` does with a cap, so it can only bring a debtor closer to broke; and zero-amount entries, which the loop skips at the cost of one
iteration. Settlement forgiveness was listed here as modelled out; it is modelled now, as Q-F below.

**Q-F. Older debts owed to third parties, and settlement debt forgiveness (Arrival PR 108, coordinator 2026-10-01): modelled for one token.** Three J-page rules, written on `chain.qnt` and `chain_test.qnt`.
(1) The dispute payout enforces the debtor's older debts first, from its reserve, then pays the peer from the spendable reserve (reserve less ALL outstanding debt), then books the rest as debt
(`Depository._settleShortfall`): `shortfall` calls `enforce`, then pays `imin(amount, spendable)`; this was modelled before (R2C-DEBT-FIRST, F13/F15: `olderDebtIsEnforcedBeforeAShortfallTest`, `debt_means_broke`,
mutants `shortfall-skips-enforce` = #108's `shortfall-skips-enforcement`, `spendable-ignores-debt` = #108's `shortfall-ahead-of-debt`). What is new is that a claim of the queue may be owed to a THIRD PARTY (another
Account of the entity): `Claim { amt, third }`, enforcement pays it out of the Account's reserves (`Money.out` counts what left, so `p3_conserved` counts it: reserves + collateral + out = total) and the peer gets none
of it; `olderThirdPartyDebtIsPaidOutBeforeAShortfallTest`, mutants `enforce-pays-third-party-claims-to-the-peer` (the reserves grow) and `enforce-skips-third-party-claims`. `init` draws a third-party flag per claim and
one claim on the other side too, so a settlement meets a head on each side.
(2) R2C checks the spendable reserve: `r2c` enforces first and needs `spendable(m1, s) >= amt` (`r2c_enforces_first`, `reserveThatIsOwedCannotBeDepositedTest`, `longQueueReserveCannotBeDepositedTest`, mutants
`r2c-skips-enforce`, `r2c-ignores-debt`); unchanged, listed so the three #108 items are in one place.
(3) Debt forgiveness by token id, as the contract reads it (`_forgiveDebtsBetweenEntities`, `MAX_SETTLEMENT_FORGIVENESS_IDS`): `settleForgiving(ids)`. For a listed token it looks at the HEAD claim of each side's queue, in
both directions: a head owed to the other side of the Account is deleted (and taken off the debt total; nobody is credited), a head owed to a third party is left. It reverts, and nothing moves, only when nothing was
forgiven and a debt exists; more than `FORGIVE_MAX` ids (32 in the contract, 2 here) revert it, and so does a token listed twice; a listed id that is not the debt token changes nothing. `forgiveJudged` states the rule from
the queues before and after (not through `forgivePlan`), `forgive_ok` is in `safe`; witnesses `w_no_forgiveness`, `w_no_forgive_revert`, `w_no_forgive_both`, `w_no_forgive_mixed`. Planted bugs, with #108's names:
`forgives-third-party` (+ `-invariant`), `forgives-one-direction`, `forgives-past-head`, `forgive-blocked-lands` (+ `-invariant`), `reverts-on-either-block`, `forgive-uncapped`, `forgive-repeat-ok`; also
`reverts-when-no-debt`, `forgive-cap-off-by-one`, `forgive-ignores-the-token-list`, `forgive-keeps-the-total`. Tests: `forgivenessTakesOnlyTheHeadOfEachSideTest`, `forgivenessWorksInTheOtherDirectionTest`,
`aThirdPartyHeadIsNotForgivenAndTheSettlementRevertsTest`, `aSettlementThatForgivesNothingRevertsTest`, `oneBlockedHeadDoesNotRevertTheSettlementTest`, `aSettlementWithNoDebtLandsTest`, `anUnlistedTokenIsLeftAloneTest`,
`aSettlementAtTheCapLandsTest`, `aSettlementOverTheCapRevertsTest`, `aTokenListedTwiceRevertsTest`.
**Not modelled (needs the multi-token Account, or more of the settlement).** (a) More than one token: the contract's loop is per listed token, each with its own queues; the model has one token, so "a listed token without debts
changes nothing" is the only per-token case, and the cap and no-repeat rules are checked on ids that name no other queue. (b) The forgiveness is not coupled to the settlement's own effect: `settleForgiving` changes the
debt queues and the ghost only, the epoch update, the offdelta fold and the co-signature of `settle.qnt` ride separately, so the model does not show that a revert on forgiveness takes the whole settlement back (E2) or
that it lands the fold and the forgiveness together; `settle.qnt` has no debt queue. (c) A part-paid head is forgiven for what is left (the claim is the queue entry, with its remaining amount); the J page says the same, I
have not read the contract for it. (d) A third-party claim is only ever paid out or left: the model has no second Account of the entity, so what the third party does with it, and whether forgiving it there is possible,
are outside. (e) The model draws a debt on each side from `init` (one claim on the non-debtor side), which `payout`'s shortfall does not create: after a dispute payout only the debtor's queue grows.
