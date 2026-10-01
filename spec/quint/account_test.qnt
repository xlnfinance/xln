// Scenario tests for account.qnt. Each drives the scripted actions through one exact schedule and states what must
// hold after it. Run with: quint test account_test.qnt --backend typescript
module account_test {
  import account.* from "./account"

  // ---- the transition table -------------------------------------------------------------------------------

  val funded: Body = { ...GENESIS, limitLeft: 2 }                 // Right extends 2 of credit to Left
  val payL1 = Pay({ from: Left, amount: 1 })
  val lockL = HtlcLock({ id: 1, payer: Left, amount: 2, hashlock: hashOf(1), deadline: 3 })

  run payNeedsRoomTest = init.expect(and {
    applyTx(GENESIS, payL1, Left, 0) == Refused("insufficient_capacity"),          // Left has no collateral share, no credit
    applyTx(GENESIS, Pay({ from: Right, amount: 2 }), Right, 0) == Ok({ ...GENESIS, offdelta: 2 }),
    applyTx(GENESIS, Pay({ from: Right, amount: 3 }), Right, 0) == Refused("insufficient_capacity"),
    applyTx(funded, payL1, Left, 0) == Ok({ ...funded, offdelta: -1 }),
    applyTx(funded, payL1, Right, 0) == Refused("not_own_funds")                    // a side can only spend its own
  })

  // N2: a lock's deadline is at most MAX_LOCK_HORIZON (plus the clock reserve, R-CLOCK) after the deciding party's own clock: the last tick is admitted, one more is refused.
  run farDeadlineIsRefusedTest = init.expect({
    val atLimit = HtlcLock({ id: 1, payer: Left, amount: 2, hashlock: hashOf(1), deadline: 1 + MAX_LOCK_HORIZON + CLOCK_RESERVE })
    val tooFar = HtlcLock({ id: 1, payer: Left, amount: 2, hashlock: hashOf(1), deadline: 2 + MAX_LOCK_HORIZON + CLOCK_RESERVE })
    and {
      applyTx(funded, atLimit, Left, 1) != Refused("deadline_too_far"),
      applyTx(funded, tooFar, Left, 1) == Refused("deadline_too_far")
    }
  })

  // The deadline second itself is still open for a resolve (the contract reads `<= deadline`); one later is not (htlcResolveMovesOffdeltaOnceTest).
  run resolveAtTheDeadlineSecondTest = init.expect({
    val locked = match applyTx(funded, lockL, Left, 1) { | Ok(b) => b | Refused(_) => GENESIS }
    applyTx(locked, HtlcResolve({ id: 1, secret: 1 }), Right, 3) != Refused("past_deadline")
  })

  // A lock whose deadline is not after the deciding party's own clock is refused; one tick after it is not.
  run lockDeadlineBoundariesTest = init.expect(and {
    applyTx(funded, HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 1 }), Left, 1) == Refused("deadline_past"),
    applyTx(funded, HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 2 }), Left, 1) != Refused("deadline_past")
  })

  // R-ONE-LOCK-PER-HASH (coordinator 09-30): an Account holds at most one open clause per hashlock, whoever the payer. The second lock is refused
  // with lock_exists; the lock stays addressed by its slot id; a different hashlock still fits the other slot.
  run oneLockPerHashlockTest = init.expect({
    val one = HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 3 })
    val locked = match applyTx(funded, one, Left, 1) { | Ok(b) => b | Refused(_) => GENESIS }
    and {
      lockCount(locked) == 1,
      applyTx(locked, HtlcLock({ id: 2, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 3 }), Left, 1) == Refused("lock_exists"),
      applyTx(locked, HtlcLock({ id: 2, payer: Right, amount: 1, hashlock: hashOf(1), deadline: 3 }), Right, 1) == Refused("lock_exists"),
      match applyTx(locked, HtlcLock({ id: 2, payer: Left, amount: 1, hashlock: hashOf(2), deadline: 3 }), Left, 1) { | Ok(b) => lockCount(b) == 2 | Refused(_) => false }
    }
  })

  // Amounts and credit limits stay inside their bounds.
  run creditAndAmountBoundsTest = init.expect(and {
    applyTx(funded, SetCredit({ by: Left, limit: MAX_CREDIT + 1 }), Left, 1) == Refused("bad_credit"),
    applyTx(funded, Pay({ from: Left, amount: MAX_AMOUNT + 1 }), Left, 1) == Refused("bad_amount"),
    applyTx(funded, HtlcLock({ id: 1, payer: Left, amount: MAX_AMOUNT + 1, hashlock: hashOf(1), deadline: 2 }), Left, 1) == Refused("bad_amount")
  })

  run creditCannotDropBelowUsageTest = init.expect({
    val used = { ...funded, offdelta: -2 }                                           // Left owes 2, limitLeft is 2
    and {
      rcpan(used),
      applyTx(used, SetCredit({ by: Right, limit: 1 }), Right, 0) == Refused("credit_below_usage"),
      applyTx(used, SetCredit({ by: Right, limit: 3 }), Right, 0) == Ok({ ...used, limitLeft: 3 })
    }
  })

  run htlcLockHoldsRoomTest = init.expect({
    val locked = match applyTx(funded, lockL, Left, 1) { | Ok(b) => b | Refused(_) => GENESIS }
    and {
      lockCount(locked) == 1,
      holds(locked, Left) == 2,
      room(locked, Left) == 0,                                                       // the lock holds all of Left's room
      applyTx(locked, payL1, Left, 1) == Refused("insufficient_capacity"),
      applyTx(locked, lockL, Left, 1) == Refused("lock_exists"),                    // a slot holds one clause
      applyTx(locked, HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(2), deadline: 3 }), Left, 1) == Refused("lock_exists"),   // also for another hashlock (R-ONE-LOCK-PER-HASH alone would not refuse it)
      rcpan(locked)
    }
  })

  // a slot holds one clause whatever its hashlock: a different hashlock in an occupied slot is refused, not written over the open clause
  // (the same-hashlock case is now refused by R-ONE-LOCK-PER-HASH first, so htlcLockHoldsRoomTest no longer reaches the slot check)
  run lockInAnOccupiedSlotIsRefusedWhateverItsHashlockTest = init.expect({
    val locked = match applyTx(funded, lockL, Left, 1) { | Ok(b) => b | Refused(_) => GENESIS }
    and {
      applyTx(locked, HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(2), deadline: 3 }), Left, 1) == Refused("lock_exists"),
      lockCount(locked) == 1
    }
  })

  run htlcResolveMovesOffdeltaOnceTest = init.expect({
    val locked = match applyTx(funded, lockL, Left, 1) { | Ok(b) => b | Refused(_) => GENESIS }
    val paid = applyTx(locked, HtlcResolve({ id: 1, secret: 1 }), Right, 2)
    and {
      paid == Ok({ ...funded, offdelta: -2 }),                                       // the payee is Right; Left pays 2
      applyTx(locked, HtlcResolve({ id: 1, secret: 2 }), Right, 2) == Refused("wrong_secret"),
      applyTx(locked, HtlcResolve({ id: 1, secret: 1 }), Left, 2) == Refused("not_payee"),
      applyTx(locked, HtlcResolve({ id: 1, secret: 1 }), Right, 4) == Refused("past_deadline")   // deadline was 3
    }
  })

  run htlcExpireAndCancelTest = init.expect({
    val locked = match applyTx(funded, lockL, Left, 1) { | Ok(b) => b | Refused(_) => GENESIS }
    and {
      applyTx(locked, HtlcExpire({ id: 1 }), Left, 3) == Refused("not_expired"),     // still open at the deadline second
      applyTx(locked, HtlcExpire({ id: 1 }), Left, 3 + CLOCK_RESERVE) == Refused("not_expired"),   // and through the reserve (R-CLOCK)
      applyTx(locked, HtlcExpire({ id: 1 }), Left, 4 + CLOCK_RESERVE) == Ok(funded),
      applyTx(locked, HtlcCancel({ id: 1 }), Right, 1) == Ok(funded),                // the payee may give it up any time
      applyTx(locked, HtlcCancel({ id: 1 }), Left, 1) == Refused("not_payee")
    }
  })

  run frameIsAllOrNothingTest = init.expect({
    // the second tx overspends: the whole frame is refused, and the proposer would have kept only the first
    val txs = List(Pay({ from: Right, amount: 2 }), Pay({ from: Right, amount: 1 }))
    and {
      replay(GENESIS, txs, Right, 0) == Refused("insufficient_capacity"),
      keepValid(GENESIS, txs, Right, 0).txs == List(Pay({ from: Right, amount: 2 })),
      keepValid(GENESIS, txs, Right, 0).body.offdelta == 2
    }
  })

  // ---- one side's queue ------------------------------------------------------------------------------------

  // Q-E1: a guard sees what is already queued. Right queues a payment of all it can pay; a lock after it is refused
  // (it would be admitted if the guard read only the committed state), and so is a second payment.
  run queuedPaymentIsVisibleToALockTest = init
    .then(enqueueTx(Right, Pay({ from: Right, amount: 2 })))
    .then(enqueueTx(Right, HtlcLock({ id: 1, payer: Right, amount: 1, hashlock: hashOf(1), deadline: 2 })))
    .fail()

  run queuedPaymentIsVisibleToAPaymentTest = init
    .then(enqueueTx(Right, Pay({ from: Right, amount: 2 })))
    .then(enqueueTx(Right, Pay({ from: Right, amount: 1 })))
    .fail()

  // ---- the frame protocol ----------------------------------------------------------------------------------

  run oneFrameCommitsOnBothSidesTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))
    .then(deliverProposal(Right, 1))
    .then(ackReceived(Right))
    .then(deliverAck(Left, 1))
    .expect(and {
      replica.get(Left).height == 1, replica.get(Right).height == 1,
      replica.get(Left).tip == replica.get(Right).tip,
      replica.get(Left).tip.limitRight == 1,
      both_signed, safe
    })

  // Both propose at height 1. Left keeps its frame; Right rolls back, restores its tx, and takes Left's.
  run collisionLeftWinsTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Left))
    .then(propose(Right))
    .then(deliverProposal(Left, 2))          // Left ignores Right's frame
    .then(deliverProposal(Right, 1))         // Right discards its own and holds Left's
    .then(ackReceived(Right))
    .then(deliverAck(Left, 1))
    .expect(and {
      rollbacks == 1,
      replica.get(Left).height == 1, replica.get(Right).height == 1,
      replica.get(Left).tip == replica.get(Right).tip,
      replica.get(Right).tip.limitRight == 1,      // Left's frame won
      replica.get(Right).tip.limitLeft == 0,       // Right's own credit tx is not in it ...
      replica.get(Right).mempool.length() == 1,    // ... it is back in the mempool, not lost
      safe
    })

  // The rolled-back tx goes out in the next frame and both sides converge on both credit limits.
  run collisionThenRetryConvergesTest = collisionLeftWinsTest
    .then(propose(Right))
    .then(deliverProposal(Left, 3))
    .then(ackReceived(Left))
    .then(deliverAck(Right, 3))
    .expect(and {
      replica.get(Left).height == 2, replica.get(Right).height == 2,
      replica.get(Left).tip == replica.get(Right).tip,
      replica.get(Left).tip.limitLeft == 2, replica.get(Left).tip.limitRight == 1,
      safe
    })

  // The ack is lost. The proposer resends; the receiver, already committed, answers with the same ack.
  run lostAckIsRecoveredByResendTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))
    .then(deliverProposal(Right, 1))
    .then(ackReceived(Right))
    .then(loseAck(1))                         // the ack is lost
    .then(resend(Left))
    .then(deliverProposal(Right, 1))          // Right is Open at height 1 and recognises the frame: same ack again
    .then(deliverAck(Left, 1))
    .expect(and { replica.get(Left).height == 1, replica.get(Right).height == 1, refusals == 0, safe })

  // A duplicate of a proposal Right already holds changes nothing and is not a refusal.
  run duplicateProposalIsIdempotentTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))
    .then(deliverProposal(Right, 1))
    .then(deliverProposal(Right, 1))
    .expect(and { isReceived(replica.get(Right)), refusals == 0 })

  // A proposal for a height the receiver already passed is refused and counted, never applied.
  run staleFrameIsRefusedTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))
    .then(deliverProposal(Right, 1))
    .then(ackReceived(Right))
    .then(deliverAck(Left, 1))
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 1 })))
    .then(propose(Right))
    .then(deliverProposal(Left, 2))
    .then(ackReceived(Left))
    .then(deliverAck(Right, 2))
    .then(deliverProposal(Right, 1))          // Left's frame 1 arrives again after both moved on to height 2
    .expect(and { replica.get(Left).height == 2, replica.get(Right).height == 2, refusals == 1, safe })

  // ---- a Byzantine proposer: the honest receiver refuses what no correct proposer would send ---------------------------------------

  // Both replicas at height 2: Right gave Left credit (frame 1), Left locked 1 towards Right until time 2 (frame 2).
  action atHeight2 = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left)).then(deliverAck(Right, 1))
    .then(enqueueTx(Left, HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 2 })))
    .then(propose(Left)).then(deliverProposal(Right, 2)).then(ackReceived(Right)).then(deliverAck(Left, 2))

  // a claimed state that is not the replay of the frame's txs
  run forgedStateIsRefusedTest = init
    .then(turnByzantine(Left)).then(byzPropose(Left, 0, 1)).then(deliverProposal(Right, 1))
    .expect(and { refusals == 1, isOpen(replica.get(Right)), replica.get(Right).height == 0, no_bad_accept, safe })

  // a skipped height
  run skippedHeightIsRefusedTest = init
    .then(turnByzantine(Left)).then(byzPropose(Left, 1, 1)).then(deliverProposal(Right, 1))
    .expect(and { refusals == 1, isOpen(replica.get(Right)), no_bad_accept, safe })

  // R-CLOCK: an expiry stamped far in the future is judged by the receiver's own clock (0), not by the stamp
  run futureStampedExpiryIsRefusedTest = atHeight2
    .then(turnByzantine(Left)).then(byzPropose(Left, 2, 1)).then(deliverProposal(Right, 3))
    .expect(and { refusals == 1, isOpen(replica.get(Right)), replica.get(Right).tip.locks.get(1).on, no_bad_accept, authority, safe })

  // R-CLOCK: a resolve stamped in the past does not reach back before the deadline: the payer judges it by its own clock (3 > 2)
  run backdatedResolveIsRefusedTest = atHeight2
    .then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right))
    .then(turnByzantine(Right)).then(byzPropose(Right, 3, 1)).then(deliverProposal(Left, 3))
    .expect(and { refusals == 1, isOpen(replica.get(Left)), replica.get(Left).tip.locks.get(1).on, replica.get(Left).tip.offdelta == 0, no_bad_accept, safe })

  // R-CLOCK: nobody refuses a frame for its age. Left proposes at time 0; the peer is away until both clocks are at 3; the same signed
  // frame, sent again, is accepted and committed. (A receiver that refused it for its stamp would leave both sides stuck, F1.)
  run oldFrameIsAcceptedAfterAnOutageTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))
    .then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right))
    .then(resend(Left)).then(deliverProposal(Right, 1))
    .expect(and { isReceived(replica.get(Right)), refusals == 0, no_bad_accept })
    .then(ackReceived(Right)).then(deliverAck(Left, 1))
    .expect(and { replica.get(Left).height == 1, replica.get(Right).height == 1, replica.get(Left).tip == replica.get(Right).tip, both_signed, safe })

  // R-CLOCK and F2 of the first review: the payer's clock is a tick ahead of the payee's (the drift the model allows). The payer's
  // expiry is refused by the payee until the payee's own clock is past the deadline and the reserve: no early expiry. The refusal names the frame, the
  // index of the first tx it refused and the fault, and the receiver remembers it as its mark (R-FRAME-REFUSAL). What the proposer does with it: the tests below.
  action lateExpiry = atHeight2
    .then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right)).then(tick(Left))
    .then(enqueueTx(Left, HtlcExpire({ id: 1 })))                 // Left's clock is 4 > 2 + reserve 1
    .then(propose(Left))
    .then(deliverProposal(Right, 3))                              // Right's clock is 3, not past 3: refused
  // the refusal in flight for a frame, whatever floor it carries (every refusal carries the refuser's signed floor, so the scripted tests name the refusal by its frame; the
  // content is checked where it matters)
  action deliverNack(s: Side, fid: int): bool = { nondet ref = nacks.filter(x => x.fid == fid).oneOf() deliverRefusal(s, ref) }
  pure def withFloor(x: Refusal, hi: int): Refusal = { ...x, hi: hi }                                    // the refuser's signed floor rides with every refusal
  val expireNack: Refusal = { ...refusalFor(3, 0, "not_expired", 0), hi: 2 }                            // Right refused Left's frame at nonce 2: its floor is 2
  pure def nonceLow(fid: int, hi: int): Refusal = { ...refusalFor(fid, 0, "nonce_low", 0), hi: hi }   // the receiver's answer to a proof that would not outrank one it signed (its `hi` rides with it)

  run expiryWaitsForTheReceiversOwnClockTest = lateExpiry
    .expect(and {
      refusals == 1, replica.get(Right).tip.locks.get(1).on, isProposed(replica.get(Left)),
      nacks == Set(expireNack), replica.get(Right).mark == Declined({ attempt: 0, index: 0, fault: "not_expired" }), authority, safe
    })

  // ---- R-FRAME-REFUSAL: the proposer's side, the attempt number and the receiver's mark --------------------------------------------

  // (a) A deadline passes while the frame is in flight. The refusal is for the frame Left has pending and unacked: Left rolls it back, the fault is retryable, so
  // the tx goes back to the mempool with no notice and the next attempt is 1. Right's view moves (the clock moves between propose and receive), Left proposes again, the
  // new frame (attempt 1, above Right's mark) is judged afresh and accepted: the Account makes progress and both sides commit. A proposer that ignores the refusal
  // keeps its frame for ever, and nothing answers (mutant `proposer-ignores-refusal`: the propose below is not enabled while a frame is pending).
  run refusedFrameIsRetriedAtTheNextAttemptTest = lateExpiry
    .then(deliverRefusal(Left, expireNack))
    .expect(and {
      isOpen(replica.get(Left)), replica.get(Left).attempt == 1, replica.get(Left).mempool == [HtlcExpire({ id: 1 })],
      replica.get(Left).refused == [], no_tx_lost, safe
    })
    .then(tick(Right))
    .then(propose(Left))
    .expect(and { frames.get(4).attempt == 1, frames.get(4).txs == [HtlcExpire({ id: 1 })], isProposed(replica.get(Left)) })
    .then(deliverProposal(Right, 4))
    .then(ackReceived(Right)).then(deliverAck(Left, 4))
    .expect(and {
      replica.get(Left).height == 3, replica.get(Right).height == 3, replica.get(Left).tip == replica.get(Right).tip,
      not(replica.get(Right).tip.locks.get(1).on), replica.get(Left).refused == [], replica.get(Left).attempt == 0, replica.get(Right).mark == NoMark,
      authority, no_tx_lost, safe
    })

  // (b) A fault that does not pass drops the named tx WITH NOTICE and the rest of the frame goes out again. Right's view is a tick ahead (R = 1, L = 0): Left's
  // lock for deadline 1 is not after it (deadline_past, at index 1, behind a credit tx that applies). Left drops the lock, keeps the credit tx, and the next frame
  // (attempt 1) commits. The lock was in the proof Left signed for frame 2 and Right holds that proof: the notice (the release of the payer and of the hold
  // above it) is kept until a frame above it commits, and then given [R-SIGNED-IS-LIVE: `refusedLockStaysLiveUntilSupersededTest` and the two after it].
  run nonRetryableFaultDropsTheNamedTxTest = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left)).then(deliverAck(Right, 1))
    .then(tick(Right))
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(enqueueTx(Left, HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 1 })))
    .then(propose(Left))
    .then(deliverProposal(Right, 2))
    .expect(and { nacks == Set(withFloor(refusalFor(2, 1, "deadline_past", 0), 1)), isOpen(replica.get(Right)), refusals == 1, isProposed(replica.get(Left)) })
    .then(deliverNack(Left, 2))
    .expect(and {
      replica.get(Left).kept == [HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 1 })], replica.get(Left).refused == [],
      replica.get(Left).mempool == [SetCredit({ by: Left, limit: 1 })], replica.get(Left).attempt == 1, isOpen(replica.get(Left)), no_tx_lost, safe
    })
    .then(propose(Left))
    .then(deliverProposal(Right, 3))
    .then(ackReceived(Right)).then(deliverAck(Left, 3))
    .then(releaseHold(Left))
    .expect(and {
      replica.get(Left).height == 2, replica.get(Right).height == 2, replica.get(Left).tip == replica.get(Right).tip,
      replica.get(Left).tip.limitRight == 1, replica.get(Left).refused.length() == 1, replica.get(Left).kept == [], replica.get(Left).submitted == 2, replica.get(Left).done == 1,
      no_tx_lost, safe
    })

  // (c) A refusal for a frame already committed is ignored: here from a peer that acked frame 1 and then refused it (a Byzantine receiver; an honest one never
  // does both). Left, Open, is unchanged; and with its next frame in flight it still keeps that frame (a refusal counts only for the pending frame).
  run refusalForACommittedFrameIsIgnoredTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))
    .then(turnByzantine(Right)).then(byzAck(Right, true))
    .then(deliverAck(Left, 1))
    .then(byzNack(Right, 1, 0, "not_expired", 0, 0))
    .then(deliverRefusal(Left, refusalFor(1, 0, "not_expired", 0)))
    .expect(and {
      replica.get(Left).height == 1, isOpen(replica.get(Left)), replica.get(Left).mempool == [], replica.get(Left).refused == [], replica.get(Left).attempt == 0, no_tx_lost, safe
    })
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 2 })))
    .then(propose(Left))
    .then(deliverRefusal(Left, refusalFor(1, 0, "not_expired", 0)))
    .expect(and {
      isProposed(replica.get(Left)), statusFid(replica.get(Left)) == 2, replica.get(Left).mempool == [], replica.get(Left).attempt == 0, replica.get(Left).refused == [], no_tx_lost, safe
    })

  // A Byzantine receiver names any fault, index and mark. It can make the honest proposer drop the tx it names, with notice, and count its attempt up past the mark;
  // never lose a tx, never commit it.
  run byzantineRefusalOnlyCostsTheNamedTxTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 2 })))
    .then(propose(Left))
    .then(turnByzantine(Right)).then(byzNack(Right, 1, 1, "bad_state", 3, 0))
    .then(deliverRefusal(Left, refusalFor(1, 1, "bad_state", 3)))
    .then(propose(Left))
    .expect(and {
      frames.get(2).attempt == 4, frames.get(2).txs == [SetCredit({ by: Left, limit: 1 })], replica.get(Left).refused == [SetCredit({ by: Left, limit: 2 })],
      replica.get(Left).height == 0, no_tx_lost, safe
    })

  // Right locks 1 towards Left (deadline 2) at height 1: the base of the two tests that need room under MAX_HEIGHT for a second frame.
  action lockedByRight = init
    .then(enqueueTx(Right, HtlcLock({ id: 1, payer: Right, amount: 1, hashlock: hashOf(1), deadline: 2 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left)).then(deliverAck(Right, 1))

  // The same refusal while the receiver has its own frame out (a collision): Right keeps its frame in flight, remembers the mark, and answers Left. Left (clock 4,
  // Right's 3) rolls its expiry back on the refusal. Right's frame, at the nonce Left signed its own proof at (nonce 2, Right-authored, below Left's own proof at 2), is
  // refused by the now Open Left with `nonce_low`: Left signed a proof for frame 2 that Right holds, and acking a frame that proof outranks would let Right erase it
  // (R-PROOF-NONCE-ABOVE-SIGNED). The refusal carries Left's `hi`; Right signs again above it, and that frame commits on both sides; Left's expiry then goes out again.
  run rightKeepsItsFrameWhenItRefusesLeftsTest = lockedByRight
    .then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right)).then(tick(Left))
    .then(enqueueTx(Left, HtlcExpire({ id: 1 })))
    .then(enqueueTx(Right, Pay({ from: Right, amount: 1 })))
    .then(propose(Left)).then(propose(Right))
    .then(deliverProposal(Right, 2))                              // Right has frame 3 out: it refuses Left's expiry (its clock is 3) and keeps its own
    .expect(and { isProposed(replica.get(Right)), statusFid(replica.get(Right)) == 3, nacks == Set(withFloor(refusalFor(2, 0, "not_expired", 0), 2)), replica.get(Right).mempool == [], rollbacks == 0 })
    .then(deliverProposal(Left, 3))                               // Left keeps its own frame (Left wins a collision)
    .then(deliverNack(Left, 2))
    .then(deliverProposal(Left, 3))                               // Left is Open now, but Right's proof (2, Right) is below the one it signed for frame 2 (2, Left): refused
    .expect(and { replica.get(Left).height == 1, nacks.contains(nonceLow(3, 2)), isOpen(replica.get(Left)), signed_above_head, safe })
    .then(deliverRefusal(Right, nonceLow(3, 2)))
    .expect(and { isOpen(replica.get(Right)), replica.get(Right).attempt == 1, replica.get(Right).mempool == [Pay({ from: Right, amount: 1 })], replica.get(Right).hi == 2, no_tx_lost, safe })
    .then(propose(Right))
    .expect(and { frames.get(4).nonce == 3, frames.get(4).attempt == 1 })
    .then(deliverProposal(Left, 4))
    .then(ackReceived(Left)).then(deliverAck(Right, 4))
    .expect(and { replica.get(Left).height == 2, replica.get(Right).height == 2, replica.get(Left).tip == replica.get(Right).tip, replica.get(Left).mempool == [HtlcExpire({ id: 1 })], no_tx_lost, signed_above_head, safe })
    .then(tick(Right))
    .then(propose(Left)).then(deliverProposal(Right, 5)).then(ackReceived(Right)).then(deliverAck(Left, 5))
    .expect(and { replica.get(Left).height == 3, replica.get(Right).height == 3, not(replica.get(Right).tip.locks.get(1).on), refusals == 2, no_tx_lost, safe })     // two refusals: Left's expiry by Right, Right's first Pay by Left (nonce_low)

  // Left sends the expiry at attempts 0, 1 and 2 and Right (its view still behind) refuses each; the third refusal finds the retry budget spent (MAX_ATTEMPT = 2), so the
  // expiry is dropped with notice. This is the schedule of the fork the attempt number and the mark are there to prevent.
  action budgetSpent = lateExpiry
    .then(deliverRefusal(Left, expireNack))
    .then(propose(Left)).then(deliverProposal(Right, 4)).then(deliverNack(Left, 4))
    .then(propose(Left)).then(deliverProposal(Right, 5)).then(deliverNack(Left, 5))

  run retryBudgetIsSpentThenTheTxIsDroppedTest = budgetSpent
    .expect(and {
      replica.get(Left).refused == [HtlcExpire({ id: 1 })], replica.get(Left).mempool == [], isOpen(replica.get(Left)), replica.get(Left).attempt == 3,
      frames.get(3).attempt == 0, frames.get(4).attempt == 1, frames.get(5).attempt == 2, replica.get(Right).mark == Declined({ attempt: 2, index: 0, fault: "not_expired" }),
      no_tx_lost, safe
    })

  // (d) The fork schedule (A4a). Right refused the expiry, Left dropped it, and now Right's view of J moves past the deadline and the reserve, so that the SAME frame
  // would apply. It must not be taken: the frame sits at the mark and is refused again (the answer repeats); the older ones are below it (stale). Right stays at
  // height 2 with the lock, as Left does. Without the mark Right would hold frame 5, ack it, and commit an expiry that Left dropped: the replicas would fork.
  run refusedFrameIsNeverTakenWhileTheHeadLastsTest = budgetSpent
    .then(tick(Right))
    .then(deliverProposal(Right, 5))
    .expect(and {
      isOpen(replica.get(Right)), replica.get(Right).height == 2, replica.get(Right).tip.locks.get(1).on, clock.get(Right) == 4,
      nacks.contains(withFloor(refusalFor(5, 0, "not_expired", 2), 5)), refusals == 4, no_bad_accept, no_orphan, safe
    })
    .then(deliverProposal(Right, 3)).then(deliverProposal(Right, 4))
    .expect(and {
      isOpen(replica.get(Right)), replica.get(Right).height == 2, nacks.contains(withFloor(refusalFor(3, 0, "stale_attempt", 2), 5)), nacks.contains(withFloor(refusalFor(4, 0, "stale_attempt", 2), 5)),
      replica.get(Left).height == 2, replica.get(Left).tip == replica.get(Right).tip, no_bad_accept, no_orphan, safe
    })
    .then(deliverNack(Left, 3))        // the answer reaches Left, which has nothing pending: ignored
    .expect(and { replica.get(Left).refused == [HtlcExpire({ id: 1 })], replica.get(Left).mempool == [], isOpen(replica.get(Left)), no_tx_lost })

  // (e) A frame below the mark is answered, with the mark (stale_attempt): the proposer moves its attempt to max(own, mark) + 1, keeps every tx (no notice) and the
  // retry costs none. Left restarted behind (`forgetAttempt`: the attempt counter went back to 0 while Right still remembers the mark 1); its next frame goes out at
  // attempt 2 and commits.
  action forgetAttempt(s: Side): bool = all {
    replica' = replica.set(s, { ...replica.get(s), attempt: 0 }),
    frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, nacks' = nacks, signed' = signed, clock' = clock, firstCommit' = firstCommit,
    diverged' = diverged, equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
  }

  run staleAttemptIsAnsweredWithTheMarkTest = lateExpiry
    .then(deliverRefusal(Left, expireNack))
    .then(propose(Left)).then(deliverProposal(Right, 4)).then(deliverNack(Left, 4))
    .then(forgetAttempt(Left))
    .then(propose(Left))
    .expect(frames.get(5).attempt == 0)
    .then(deliverProposal(Right, 5))
    .expect(and { nacks.contains(withFloor(refusalFor(5, 0, "stale_attempt", 1), 4)), replica.get(Right).mark == Declined({ attempt: 1, index: 0, fault: "not_expired" }), isOpen(replica.get(Right)) })
    .then(deliverNack(Left, 5))
    .expect(and {
      replica.get(Left).attempt == 2, replica.get(Left).mempool == [HtlcExpire({ id: 1 })], replica.get(Left).refused == [], isOpen(replica.get(Left)), no_tx_lost, safe
    })
    .then(tick(Right))
    .then(propose(Left)).then(deliverProposal(Right, 6)).then(ackReceived(Right)).then(deliverAck(Left, 6))
    .expect(and { frames.get(6).attempt == 2, replica.get(Left).height == 3, replica.get(Right).height == 3, replica.get(Left).tip == replica.get(Right).tip, no_tx_lost, safe })

  // (f) The mark is forgotten when the head moves. Left refused Right's expiry (mark 0, Left's clock is behind), then Left's own frame commits on both sides (the head
  // moves); Right's expiry, sent again at attempt 0 (its own count restarted with the head), is judged afresh and accepted. A receiver that kept the mark would
  // refuse it for ever (mutant `mark-kept-across-head-moves`).
  run markIsForgottenWhenTheHeadMovesTest = lockedByRight
    .then(tick(Right)).then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right))
    .then(enqueueTx(Right, HtlcExpire({ id: 1 })))                // Right's clock is 4, Left's 3
    .then(propose(Right))
    .then(deliverProposal(Left, 2))
    .expect(replica.get(Left).mark == Declined({ attempt: 0, index: 0, fault: "not_expired" }))
    .then(deliverNack(Right, 2))
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left)).then(deliverProposal(Right, 3)).then(ackReceived(Right)).then(deliverAck(Left, 3))
    .expect(and {
      replica.get(Left).mark == NoMark, replica.get(Right).attempt == 0, replica.get(Left).height == 2, replica.get(Right).height == 2,
      replica.get(Right).mempool == [HtlcExpire({ id: 1 })], safe
    })
    .then(tick(Left))
    .then(propose(Right))
    .then(deliverProposal(Left, 4)).then(ackReceived(Left)).then(deliverAck(Right, 4))
    .expect(and { frames.get(4).attempt == 0, replica.get(Left).height == 3, replica.get(Right).height == 3, not(replica.get(Left).tip.locks.get(1).on), no_tx_lost, safe })

  // The proposer's rule as a function: what it does with a refusal, by case.
  run refusalHandlingTest = init.expect({
    val a = SetCredit({ by: Left, limit: 1 })
    val b = SetCredit({ by: Left, limit: 2 })
    val c = SetCredit({ by: Left, limit: 3 })
    val x = Pay({ from: Left, amount: 1 })
    val f = { ...NO_FRAME, txs: [a, b, c] }
    val pend = { ...EMPTY_REPLICA, status: Proposed(1), attempt: 1, mempool: [x] }
    val retried = onRefusal(pend, refusalFor(1, 1, "not_expired", 1), f)
    val spent = onRefusal({ ...pend, attempt: MAX_ATTEMPT }, refusalFor(1, 1, "not_expired", MAX_ATTEMPT), f)
    val dropped = onRefusal(pend, refusalFor(1, 1, "deadline_past", 1), f)
    val stale = onRefusal({ ...pend, attempt: MAX_ATTEMPT + 1 }, refusalFor(1, 0, "stale_attempt", 0), f)
    and {
      retried.mempool == [a, b, c, x], retried.refused == [], retried.attempt == 2, isOpen(retried),                  // every tx back, ahead of the mempool; no notice
      spent.mempool == [a, c, x], spent.refused == [b], spent.attempt == MAX_ATTEMPT + 1,                              // the budget is spent: the named tx is dropped with notice
      dropped.mempool == [a, c, x], dropped.refused == [b], dropped.attempt == 2,
      stale.mempool == [a, b, c, x], stale.refused == [], stale.attempt == MAX_ATTEMPT + 2,                            // max(own, mark) + 1: the mark is below, so its own count decides
      onRefusal(pend, refusalFor(1, 3, "bad_state", 0), f) == pend,                                                    // an index that names no tx of the frame: ignored
      onRefusal(pend, refusalFor(1, -1, "bad_state", 0), f) == pend,
      onRefusal(pend, refusalFor(2, 0, "not_expired", 0), f) == pend,                                                  // not the frame in flight
      onRefusal({ ...pend, status: Open }, refusalFor(1, 0, "not_expired", 0), f) == { ...pend, status: Open }          // nothing in flight (committed, or rolled back already)
    }
  })

  // A frame authored by this very replica is never taken, whatever it says (the frame is the next one and replays): `inLine` states it, a delivery never offers one.
  run ownFrameIsNeverTakenTest = init.expect({
    val f = { ...NO_FRAME, height: 1, nonce: 1, author: Left, txs: [SetCredit({ by: Left, limit: 1 })], after: { ...GENESIS, limitRight: 1 } }
    and {
      acceptable(EMPTY_REPLICA, 0, f, Right),
      not(acceptable(EMPTY_REPLICA, 0, f, Left)),
      isOpen(onPropose(EMPTY_REPLICA, 0, Left, 1, f, NO_FRAME).r)
    }
  })

  // A frame that is not next in line is refused without an answer and leaves no mark (nothing honest sends one); the receiver's mark is only about frames it judged.
  run frameNotInLineLeavesNoMarkTest = init.expect({
    val f = { ...NO_FRAME, height: 2, nonce: 1, author: Left, txs: [HtlcExpire({ id: 1 })], after: GENESIS }
    val o = onPropose(EMPTY_REPLICA, 0, Right, 1, f, NO_FRAME)
    and { o.refused, o.say == NO_REFUSAL, o.r == EMPTY_REPLICA }
  })

  // The Byzantine peer acks with a signature over a different proof: the honest proposer does not commit on it.
  run ackOverAnotherProofIsIgnoredTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))
    .then(turnByzantine(Right)).then(byzAck(Right, false))
    .then(deliverAck(Left, 1))
    .expect(and { replica.get(Left).height == 0, isProposed(replica.get(Left)), both_signed, safe })

  // ... and on the correct ack it does.
  run correctAckFromAByzantinePeerCommitsTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))
    .then(turnByzantine(Right)).then(byzAck(Right, true))
    .then(deliverAck(Left, 1))
    .expect(and { replica.get(Left).height == 1, both_signed, safe })

  // R-CLOCK: a frame stamped 0 (or far ahead) by a Byzantine proposer is accepted when it is otherwise correct, at whatever time.
  run oddStampsAreAcceptedTest = init
    .then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right))
    .then(turnByzantine(Left)).then(byzStamped(Left, false))
    .then(deliverProposal(Right, 1)).then(ackReceived(Right))
    .expect(and { replica.get(Right).height == 1, refusals == 0, both_signed, safe })

  // A side with nothing queued proposes nothing.
  run emptyFrameIsNotProposedTest = init.then(propose(Left)).fail()

  // Right rolls back on a collision and its own txs go back in front of the ones queued since (their order is the order they were made).
  run rollbackKeepsTheOrderTest = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 1 })))
    .then(propose(Right))
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))
    .then(deliverProposal(Right, 2))
    .expect(replica.get(Right).mempool == [SetCredit({ by: Right, limit: 1 }), SetCredit({ by: Right, limit: 2 })])

  // A receiver holding one frame for its ack refuses a second, correct frame at the same height (from an equivocating peer).
  run receivedFrameIsNotReplacedTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))
    .then(deliverProposal(Right, 1))
    .then(turnByzantine(Left)).then(byzStamped(Left, false))
    .then(deliverProposal(Right, 2))
    .expect(and { statusFid(replica.get(Right)) == 1, refusals == 1 })

  // RCPAN in the worst case over open clauses (stated on both ends, holds counted): a clause that would push the allocation outside the range if it
  // resolved for its payee makes the body unacceptable, on the high side and on the low side.
  pure def lockOf(payer: Side, amount: int): Lock = { on: true, payer: payer, amount: amount, hashlock: hashOf(1), deadline: 3 }

  run rcpanCoversTheWorstCaseOfOpenClausesTest = init.expect({
    val highBad = withLock({ ...GENESIS, offdelta: 1 }, 1, lockOf(Right, 2))          // 1 + 2 > COLLATERAL + limitRight (2)
    val lowBad = withLock({ ...GENESIS, offdelta: 0 }, 1, lockOf(Left, 1))            // 0 - 1 < -limitLeft (0)
    val fits = withLock({ ...GENESIS, offdelta: 1 }, 1, lockOf(Right, 1))             // 1 + 1 <= 2
    and { not(rcpan(highBad)), not(rcpan(lowBad)), rcpan(fits) }
  })

  // An ack for an older frame arrives while a newer frame is in flight: it does not commit anything.
  run oldAckDoesNotCommitTheFrameInFlightTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))
    .then(deliverProposal(Right, 1))
    .then(ackReceived(Right))
    .then(deliverAck(Left, 1))                    // frame 1 commits
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 2 })))
    .then(propose(Left))                          // frame 2 in flight
    .then(deliverAck(Left, 1))                    // the old ack arrives again
    .expect(and { replica.get(Left).height == 1, isProposed(replica.get(Left)), safe })

  // N1: a proof nonce that is not above the last committed one, and one that leaps, are both refused; the frame is otherwise correct
  run staleProofNonceIsRefusedTest = init
    .then(turnByzantine(Left)).then(byzPropose(Left, 4, 1)).then(deliverProposal(Right, 1))
    .expect(and { refusals == 1, isOpen(replica.get(Right)), replica.get(Right).height == 0, no_bad_accept, safe })

  run leapingProofNonceIsRefusedTest = init
    .then(turnByzantine(Left)).then(byzPropose(Left, 5, 1)).then(deliverProposal(Right, 1))
    .expect(and { refusals == 1, isOpen(replica.get(Right)), replica.get(Right).height == 0, no_bad_accept, safe })

  // A12 (closed): Left acked Right's frame and committed it; the ack is lost; Left's key is then taken and it sends another frame for the same height.
  // At one proof nonce the chain ranks the Left-authored proof above the Right-authored one, and the honest Right signed that frame itself, so taking it
  // is not a disagreement: it is the frame the chain settles.
  run equivocatingLeftIsSupersededByRankTest = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 1 })))
    .then(propose(Right))
    .then(deliverProposal(Left, 1))
    .then(ackReceived(Left))                      // Left commits Right's frame
    .then(loseAck(1))
    .then(turnByzantine(Left))
    .then(byzStamped(Left, false))                // frame 2: Left-authored, the same height and nonce
    .then(deliverProposal(Right, 2))              // Right is the collision loser: it rolls back and takes Left's frame
    .then(ackReceived(Right))
    .expect(and { replica.get(Left).height == 1, replica.get(Right).height == 1, replica.get(Left).tip != replica.get(Right).tip, not(diverged), superseded, safe })

  // A12 by rank, the second schedule (found by a longer simulation): a peer acks Right's frame (Left commits it; the ack is lost), its key is then taken, and it REFUSES that
  // frame: Right drops the lock it names and sends the credit tx again, at a higher nonce, and the peer acks that. Left holds the first frame committed and Right the retry: both
  // Right-authored. The chain ranks the retry (nonce 2) above the first frame (nonce 1), and Right signed it itself, so it is the frame the chain settles, not a fork. The lock
  // went to the next hop in a proof Right signed at nonce 1 and that sits below the head now: its notice is released only after that commit.
  run ackedThenRefusedThenRetryAckedIsSupersededByRankTest = init
    .then(enqueueTx(Right, HtlcLock({ id: 1, payer: Right, amount: 1, hashlock: hashOf(1), deadline: 4 })))
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 3 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left))
    .then(turnByzantine(Left)).then(byzNack(Left, 1, 0, "bad_state", 0, 0))
    .then(deliverRefusal(Right, refusalFor(1, 0, "bad_state", 0)))
    .expect(and { replica.get(Right).kept == [HtlcLock({ id: 1, payer: Right, amount: 1, hashlock: hashOf(1), deadline: 4 })], replica.get(Right).refused == [], no_tx_lost })
    .then(propose(Right)).then(byzAck(Left, true)).then(deliverAck(Right, 2))
    .expect(and {
      replica.get(Left).height == 1, replica.get(Right).height == 1, replica.get(Left).tip != replica.get(Right).tip,
      proofRank(frames.get(2)) > proofRank(frames.get(1)), not(diverged), superseded, signed_above_head, safe
    })
    .then(releaseHold(Right))
    .expect(and { replica.get(Right).kept == [], replica.get(Right).refused.length() == 1, no_tx_lost, safe })

  // #57 sequence (coordinator): a payer co-signs a frame stamped far ahead of every clock, and the payee's held reveal follows. The stamp decides
  // nothing (R-CLOCK): the payee's resolve is judged by its own clock (0 <= deadline 2) and is proposed and would be accepted. The frame's stamp is
  // informational, and a J height a proposer claims is untrusted for the same reason (the model has no J height; A8).
  run futureStampedFrameDoesNotBlockTheRevealTest = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left)).then(deliverAck(Right, 1))
    .then(enqueueTx(Left, HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 2 })))
    .then(turnByzantine(Left)).then(byzStampedQueued(Left))
    .then(deliverProposal(Right, 2)).then(ackReceived(Right))                       // the future-stamped lock frame is committed
    .expect(and { replica.get(Right).height == 2, frames.get(2).ts > 50, refusals == 0, replica.get(Right).tip.locks.get(1).on })
    .then(enqueueTx(Right, HtlcResolve({ id: 1, secret: 1 })))                      // the held reveal arrives
    .then(propose(Right))
    .expect(and { isProposed(replica.get(Right)), frames.get(3).txs == [HtlcResolve({ id: 1, secret: 1 })], safe })

  // ---- round of 09-30: the Account comparison decisions -------------------------------------------------------------

  // R-REACK (D-AC-1). Right proposes frame 1, Left commits it and acks, the ack is lost. Left then proposes its own frame 2 and is Proposed when Right resends
  // frame 1. Left must still re-ack it (before this round it refused, and both sides were stuck for ever). Afterwards both sides converge at height 2.
  run lostAckWhileHoldingOwnFrameTest = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Right))
    .then(deliverProposal(Left, 1))
    .then(ackReceived(Left))
    .then(loseAck(1))
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))                               // Left holds its own frame 2 and is Proposed
    .then(resend(Right))
    .then(deliverProposal(Left, 1))                    // the repeat of the frame Left committed: re-acked although Left is Proposed
    .expect(and { acks.contains(1), refusals == 0, replica.get(Right).height == 0 })
    .then(deliverAck(Right, 1))
    .then(deliverProposal(Right, 2))
    .then(ackReceived(Right))
    .then(deliverAck(Left, 2))
    .expect(and {
      replica.get(Left).height == 2, replica.get(Right).height == 2, replica.get(Left).tip == replica.get(Right).tip,
      replica.get(Left).tip.limitLeft == 2, replica.get(Left).tip.limitRight == 1, refusals == 0, safe
    })

  // R-NOTICE (D-AC-5). Height 1: Right grants Left credit. Height 2: both propose a lock in slot 1, Left wins, Right's lock goes back to its mempool and can
  // never apply. Before this round it sat there for ever, unreported. Now the side refuses it with notice and the mempool is empty.
  action deadTx = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left)).then(deliverAck(Right, 1))
    .then(enqueueTx(Left, HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 2 })))
    .then(enqueueTx(Right, HtlcLock({ id: 1, payer: Right, amount: 1, hashlock: hashOf(2), deadline: 2 })))
    .then(propose(Left)).then(propose(Right))
    .then(deliverProposal(Left, 3)).then(deliverProposal(Right, 2)).then(ackReceived(Right)).then(deliverAck(Left, 2))

  run deadTxIsRefusedWithNoticeTest = deadTx
    .expect(and { replica.get(Right).mempool.length() == 1, not(canPropose(replica.get(Right), clock.get(Right), Right)), no_tx_lost })
    .then(reviseMempool(Right))
    .expect(and {
      replica.get(Right).mempool.length() == 0, replica.get(Right).refused == [HtlcLock({ id: 1, payer: Right, amount: 1, hashlock: hashOf(2), deadline: 2 })],
      replica.get(Right).submitted == 2, replica.get(Right).done == 1, no_tx_lost, safe
    })

  // R-NOTICE at propose: a mempool of a dead tx and a live one proposes the live one and refuses the dead one with notice.
  run deadTxBesideALiveOneIsNoticedAtProposeTest = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left)).then(deliverAck(Right, 1))
    .then(enqueueTx(Left, HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 2 })))
    .then(enqueueTx(Right, HtlcLock({ id: 1, payer: Right, amount: 1, hashlock: hashOf(2), deadline: 2 })))
    .then(enqueueTx(Right, Pay({ from: Right, amount: 1 })))
    .then(propose(Left)).then(propose(Right))
    .then(deliverProposal(Left, 3)).then(deliverProposal(Right, 2)).then(ackReceived(Right)).then(deliverAck(Left, 2))
    .then(propose(Right))
    .expect(and {
      frames.get(4).txs == [Pay({ from: Right, amount: 1 })], replica.get(Right).refused.length() == 1, no_tx_lost, safe
    })

  // R-PARENT (D-AC-7). A frame at the next height whose parent is not the receiver's head is refused, although it would replay.
  run wrongParentIsRefusedTest = init
    .then(turnByzantine(Left)).then(byzPropose(Left, 6, 1)).then(deliverProposal(Right, 1))
    .expect(and { refusals == 1, isOpen(replica.get(Right)), replica.get(Right).height == 0, no_bad_accept, safe })

  // ---- R-PROOF-NONCE-ABOVE-SIGNED (coordinator 10-01; Review A of PR 97, finding 0001) ---------------------------------------------------------
  // Every committed frame's proof nonce is strictly above every proof nonce either side signed in the epoch, the yielded and refused attempts included,
  // and no frame commits under a proof the peer holds that outranks it by the chain's order (nonce, then Left over Right at one nonce). The two schedules of
  // the review, and the third that the guard of the receiver is for. `signed_above_head` states the rule on the signed history; the tests also read the nonces.

  // Right's lock names a deadline Right's view admits and Left's, a tick behind, finds too far ahead (deadline_too_far, retryable): frame 1 at nonce 1 is refused.
  val farLockR = HtlcLock({ id: 1, payer: Right, amount: 1, hashlock: hashOf(1), deadline: 6 })
  action rightsFarLockRefused = init
    .then(tick(Right))
    .then(enqueueTx(Right, farLockR))
    .then(propose(Right))
    .then(deliverProposal(Left, 1))
    .expect(and { nacks == Set(refusalFor(1, 0, "deadline_too_far", 0)), replica.get(Left).hi == 1, replica.get(Left).sig == 0, signed_above_head, safe })

  // (a) Right YIELDS at attempt 1 to Left's first frame. Left refused attempt 0 (so it has seen the proof at nonce 1) and proposes its own first frame above it, at 2; Right's
  // retry signs above its own attempt 0, at 2 as well; the frames cross, Left keeps its own and Right yields. Right's yielded proof (2, Right) is held by Left, and
  // it must rank below the committed (2, Left). With the nonce taken from the committed tip plus the attempt (the old rule) Left's first frame is at 1 and the retry at 2:
  // the yielded proof outranks the frame that committed, and Left, holding it, starts a dispute with it and reverses Left's payment (mutant `nonce-from-the-committed-tip`).
  run yieldAtTheRetryLeavesNoHigherProofTest = rightsFarLockRefused
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))                                              // frame 2: Left's first frame, above the refused proof it has seen: nonce 2
    .then(deliverNack(Right, 1))
    .then(propose(Right))                                             // frame 3: attempt 1, above Right's own attempt 0: nonce 2
    .expect(and { frames.get(2).nonce == 2, frames.get(3).nonce == 2, frames.get(3).attempt == 1 })
    .then(deliverProposal(Left, 3))                                   // Left keeps its own frame
    .then(deliverProposal(Right, 2))                                  // Right yields to it
    .expect(and {
      rollbacks == 1, isReceived(replica.get(Right)),
      replica.get(Right).mempool == [farLockR], replica.get(Right).kept == [], replica.get(Right).refused == [],    // a yield releases nothing: the lock is still Right's to propose
      no_tx_lost
    })
    .then(ackReceived(Right)).then(deliverAck(Left, 2))
    .expect(and {
      replica.get(Left).height == 1, replica.get(Right).height == 1, replica.get(Left).tip == replica.get(Right).tip,
      proofRank(frames.get(3)) < proofRank(frames.get(2)),                   // the yielded proof is below the committed one: the order the chain applies
      signed_above_head, no_equivocation, no_release_while_signed_live, safe
    })
    .then(tick(Left))                                                  // Left's view reaches the deadline's horizon; Right's lock goes out again and commits above both
    .then(propose(Right)).then(deliverProposal(Left, 4)).then(ackReceived(Left)).then(deliverAck(Right, 4))
    .expect(and {
      frames.get(4).nonce == 3, replica.get(Left).height == 2, replica.get(Right).height == 2, replica.get(Left).tip.locks.get(1).on,
      replica.get(Right).kept == [], replica.get(Right).refused == [], signed_above_head, safe
    })

  // (b) Right REFUSES Left's first attempt and then commits its own frame. Left's attempt 0 is a proof (2, Left) that Right holds. Right's own frame, proposed after it has
  // seen and refused that proof, must be above it: at 3. At 2 (the committed tip plus one: mutant `nonce-ignores-seen-proofs`, and the old rule) it would tie the proof Left
  // signed, and at one nonce the chain ranks the Left-authored proof above the Right-authored one: Right, holding Left's stale proof, starts a dispute with it and erases
  // the frame that committed (here a payment Right made to Left).
  val farLockL = HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 6 })
  run refuseThenCommitAtTheSameNonceLeavesNoHigherProofTest = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left)).then(deliverAck(Right, 1))      // height 1 at nonce 1: Left may owe
    .then(tick(Left))                                                  // Left's view is a tick ahead of Right's: its lock for deadline 6 is too far for Right
    .then(enqueueTx(Left, farLockL))
    .then(propose(Left))                                               // frame 2, nonce 2, Left-authored
    .then(deliverProposal(Right, 2))
    .expect(and { nacks == Set(withFloor(refusalFor(2, 0, "deadline_too_far", 0), 1)), replica.get(Right).hi == 2 })    // the floor is what Right held before it saw the frame
    .then(enqueueTx(Right, Pay({ from: Right, amount: 1 })))
    .then(propose(Right))                                              // frame 3: above the proof Right has seen Left sign
    .expect(frames.get(3).nonce == 3)
    .then(deliverNack(Left, 2))
    .then(deliverProposal(Left, 3)).then(ackReceived(Left)).then(deliverAck(Right, 3))
    .expect(and {
      replica.get(Left).height == 2, replica.get(Right).height == 2, replica.get(Left).tip == replica.get(Right).tip, replica.get(Left).tip.offdelta == 1,
      proofRank(frames.get(3)) > proofRank(frames.get(2)), replica.get(Left).mempool == [farLockL],
      signed_above_head, no_equivocation, safe
    })

  // (b') R-A1 by rank (the kernel's round 2): a collision is won by the higher slot, and at one slot by the Left-authored frame. Left proposes frame 2 at nonce 2; Right refuses it
  // (it holds a proof at 2 now) and proposes its own frame 3 ABOVE it, at 3, before Left has heard the refusal. Frame 3 reaches Left while Left still has frame 2 in flight: the
  // higher slot wins even against Left, so Left yields (its lock goes back to its mempool, no notice: its proof at 2 stays signed below the one that commits). Left wins a collision
  // only at one slot (`collisionLeftWinsTest`). Mutants `collision-won-by-the-lower-slot` and `collision-left-always-wins`.
  run collisionIsWonByTheHigherSlotTest = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left)).then(deliverAck(Right, 1))
    .then(tick(Left))
    .then(enqueueTx(Left, farLockL))
    .then(propose(Left))
    .then(deliverProposal(Right, 2))
    .then(enqueueTx(Right, Pay({ from: Right, amount: 1 })))
    .then(propose(Right))
    .expect(and { frames.get(2).nonce == 2, frames.get(3).nonce == 3, proofRank(frames.get(3)) > proofRank(frames.get(2)), isProposed(replica.get(Left)) })
    .then(deliverProposal(Left, 3))
    .expect(and {
      rollbacks == 1, isReceived(replica.get(Left)), replica.get(Left).mempool == [farLockL], replica.get(Left).kept == [], replica.get(Left).refused == [],
      sigLockRanks(replica.get(Left)) == [5], isProposed(replica.get(Right)), no_tx_lost, signed_above_head, safe
    })
    .then(ackReceived(Left)).then(deliverAck(Right, 3))
    .then(deliverNack(Left, 2))                                       // the refusal of the yielded frame arrives: nothing is in flight, ignored
    .expect(and {
      replica.get(Left).height == 2, replica.get(Right).height == 2, replica.get(Left).tip == replica.get(Right).tip, replica.get(Left).tip.offdelta == 1,
      replica.get(Left).mempool == [farLockL], replica.get(Left).refused == [], sigLockRanks(replica.get(Left)) == [],
      no_tx_lost, signed_above_head, no_equivocation, safe
    })

  // (c) The same collision with both frames in flight (Right proposed before it saw Left's). Right refuses Left's frame and keeps its own at nonce 2; Left, Open again after the
  // refusal, holds its own proof (2, Left) and is asked to ack Right's (2, Right): it must not, or Right's committed frame is outranked by a proof Right holds
  // (mutant `acker-ignores-its-own-signed-proofs`). It answers `nonce_low` with its `hi`, and Right signs again above it: `rightKeepsItsFrameWhenItRefusesLeftsTest` is this schedule
  // with an expiry for Left's frame. Here the proof the acker signed is the one of a refused lock.
  run ackerRefusesAProofBelowTheOneItSignedTest = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left)).then(deliverAck(Right, 1))
    .then(tick(Left))
    .then(enqueueTx(Left, farLockL)).then(enqueueTx(Right, Pay({ from: Right, amount: 1 })))
    .then(propose(Left)).then(propose(Right))                          // frames 2 (Left, nonce 2) and 3 (Right, nonce 2): both at nonce 2
    .then(deliverProposal(Right, 2))                                   // Right refuses Left's lock and keeps its own frame
    .then(deliverProposal(Left, 3))                                    // Left, still Proposed, keeps its own
    .then(deliverNack(Left, 2))
    .then(deliverProposal(Left, 3))                                    // Left is Open: (2, Right) is below the (2, Left) it signed
    .expect(and { nacks.contains(nonceLow(3, 2)), replica.get(Left).height == 1, isOpen(replica.get(Left)), signed_above_head, safe })
    .then(deliverRefusal(Right, nonceLow(3, 2)))
    .then(propose(Right))
    .expect(and { frames.get(4).nonce == 3, frames.get(4).attempt == 1 })
    .then(deliverProposal(Left, 4)).then(ackReceived(Left)).then(deliverAck(Right, 4))
    .expect(and {
      replica.get(Left).height == 2, replica.get(Right).height == 2, replica.get(Left).tip == replica.get(Right).tip,
      replica.get(Right).refused == [], replica.get(Right).mempool == [], proofRank(frames.get(4)) > proofRank(frames.get(2)), signed_above_head, no_tx_lost, safe
    })

  // A `nonce_low` answer costs the proposer no tx whatever its budget, and teaches it the receiver's floor. A floor more than one above what the proposer knows signed is more than an
  // honest peer could hold (its own latest proof, which the proposer has not seen, and nothing more): the refusal is refused, the frame stays in flight, and a Byzantine receiver can
  // neither burn the counter nor make the proposer drop a tx by it (R-PROOF-NONCE-ABOVE-SIGNED, the reachable bound).
  run nonceLowCostsNoTxTest = init.expect({
    val a = SetCredit({ by: Left, limit: 1 })
    val f = { ...NO_FRAME, txs: [a] }
    val pend = { ...EMPTY_REPLICA, status: Proposed(1), attempt: MAX_ATTEMPT, hi: 2, sig: 5 }
    val r = onRefusal(pend, nonceLow(1, 3), f)
    val burn = onRefusal(pend, nonceLow(1, 4), f)
    val burnAny = onRefusal(pend, withFloor(refusalFor(1, 0, "bad_state", 0), 99), f)
    and {
      r.mempool == [a], r.refused == [], r.kept == [], isOpen(r), r.hi == 3,
      burn == pend, burnAny == pend,                                              // out of reach: ignored, whatever the fault
      onRefusal(pend, refusalFor(1, 0, "bad_state", 0), f).mempool == []         // any other fault past the budget still drops the tx
    }
  })

  // Every refusal carries the refuser's signed floor (the kernel's round 2): a receiver holding `hi` 4 answers with 4 whatever the frame is refused for (a tx that does not apply,
  // a stale attempt, a proof below its own), and the proposer's retry is signed above it. A refusal with no floor leaves the proposer to sign at a slot the refuser holds a proof at.
  run everyRefusalCarriesTheFloorTest = init.expect({
    val rep = { ...EMPTY_REPLICA, hi: 4, sig: 3 }
    val frame = { ...NO_FRAME, height: 1, nonce: 5, author: Left, txs: [Pay({ from: Left, amount: 1 })] }       // Left pays with no credit: refused
    val o = judge(rep, 0, Right, 1, frame)
    val stale = judge({ ...rep, mark: Declined({ attempt: 2, index: 0, fault: "bad_state" }) }, 0, Right, 1, { ...frame, attempt: 1 })
    val low = judge({ ...rep, sig: 99 }, 0, Right, 1, frame)
    val pend = { ...EMPTY_REPLICA, status: Proposed(1), attempt: 0, hi: 3 }
    val back = onRefusal(pend, o.say, frame)
    and {
      o.refused, o.say.fault != "", o.say.hi == 4,
      stale.say.fault == "stale_attempt", stale.say.hi == 4,
      low.say.fault == "nonce_low", low.say.hi == 4,
      back.hi == 4, frameToPropose({ ...back, mempool: [] }, 0, Left, 0).nonce == 5     // the retry is above the refuser's floor
    }
  })


  // The rank, not the nonce alone, is what a receiver compares: at one nonce the Left-authored proof outranks the Right-authored one, so a Left frame may follow a Right proof
  // the receiver signed at that nonce, and the other way round it may not.
  run receiverComparesRanksTest = init.expect({
    val f = { ...NO_FRAME, height: 1, nonce: 2, author: Left, txs: [SetCredit({ by: Left, limit: 1 })], after: { ...GENESIS, limitRight: 1 } }
    val rightSigned = { ...EMPTY_REPLICA, hi: 2, sig: 4 }                           // the receiver signed (2, Right)
    val leftSigned = { ...EMPTY_REPLICA, hi: 2, sig: 5 }                            // it signed (2, Left)
    and {
      acceptable(rightSigned, 0, f, Right),                                          // (2, Left) is above (2, Right)
      not(acceptable(leftSigned, 0, f, Right)),                                      // but not above itself
      not(acceptable(leftSigned, 0, { ...f, author: Right }, Left)),                 // and (2, Right) is never above (2, Left)
      not(acceptable({ ...EMPTY_REPLICA, hi: 3, sig: 7 }, 0, f, Right))              // a lower nonce is refused whoever authored it
    }
  })

  // The window is one above the highest nonce the receiver knows signed: a proof at hi + 2 leaps, at hi + 1 it is next.
  run windowIsOneAboveWhatTheReceiverKnowsTest = init.expect({
    val f = { ...NO_FRAME, height: 1, nonce: 3, author: Left, txs: [SetCredit({ by: Left, limit: 1 })], after: { ...GENESIS, limitRight: 1 } }
    and {
      inLine({ ...EMPTY_REPLICA, hi: 2 }, f, Right),
      not(inLine({ ...EMPTY_REPLICA, hi: 1 }, f, Right)),
      inLine({ ...EMPTY_REPLICA, hi: 3 }, { ...f, nonce: 3 }, Right)
    }
  })

  // The proposer's next nonce is one above the highest it knows signed, its own and the peer's it has seen, and never from the tip alone.
  run proposerSignsAboveEverythingItKnowsTest = init.expect({
    val r = { ...EMPTY_REPLICA, pnonce: 1, hi: 4, mempool: [SetCredit({ by: Left, limit: 1 })] }
    and { frameToPropose(r, 0, Left, 0).nonce == 5, frameToPropose({ ...r, hi: 0 }, 0, Left, 0).nonce == 2 }
  })

  // The receiver learns the nonce of a frame that is next in line, held, refused or ignored in a collision: the peer signed it.
  run seenProofsRaiseTheKnownNonceTest = init.expect({
    val f = { ...NO_FRAME, height: 1, nonce: 1, author: Right, txs: [HtlcExpire({ id: 1 })], after: GENESIS }                     // an expiry of no lock: refused
    val seen = onPropose(EMPTY_REPLICA, 0, Left, 1, f, NO_FRAME)
    val stale = onPropose({ ...EMPTY_REPLICA, height: 1, lastFid: 7 }, 0, Left, 1, f, NO_FRAME)                                 // not next in line: not learned
    and { seen.refused, seen.r.hi == 1, stale.r.hi == 0 }
  })

  // ---- R-SIGNED-IS-LIVE (coordinator 10-01, narrows R-REFUSED-RELEASES-PAYER) ------------------------------------------------------------------------------
  // Anything a side has signed stays enforceable against it until a higher-nonce frame commits: its peer holds the proof and can start a dispute with it (chain.qnt: a start
  // needs a proof signed by the other party, and nothing else; compose.qnt `refusedProofWithTheLockIsEnforcedOnTheChainTest` plays that). So a refusal or a yield does not
  // release the payer's hold, nor the hold above it (the Entity's upstream lock), for a lock that sits in such a proof: the notice waits (`kept`) until the proof is
  // superseded or the deadline plus the reserve has passed. `no_release_while_signed_live` states it on the signed history at the moment a notice is given.

  val lockD1 = HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 1 })
  // Left's frame 2 carries a credit tx and a lock whose deadline is not after Right's view (deadline_past, not retryable): refused, the lock dropped. Frame 2 is signed by Left.
  action lockRefused = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left)).then(deliverAck(Right, 1))
    .then(tick(Right))
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(enqueueTx(Left, lockD1))
    .then(propose(Left))
    .then(deliverProposal(Right, 2))
    .then(deliverNack(Left, 2))

  // The refusal does not release: the notice is kept, the release is not enabled, and the ghost says no lock was released over a live proof.
  run refusalDoesNotReleaseTheHoldTest = lockRefused
    .expect(and {
      replica.get(Left).kept == [lockD1], replica.get(Left).refused == [], isOpen(replica.get(Left)), no_tx_lost,
      sigLockRanks(replica.get(Left)) == [5], not(relBad), no_release_while_signed_live, safe
    })
    .then(releaseHold(Left)).fail()

  pure def sigLockRanks(r: Replica): List[int] = r.sigLocks.foldl([], (acc, e) => acc.append(e.rank))

  // ... and a frame above it commits: the proof is superseded (Left's frame 3 is at nonce 3, above frame 2's proof at 2), the release is enabled, and the notice is given.
  run supersessionReleasesTheHoldTest = lockRefused
    .then(propose(Left)).then(deliverProposal(Right, 3)).then(ackReceived(Right)).then(deliverAck(Left, 3))
    .expect(and { replica.get(Left).height == 2, frames.get(3).nonce == 3, replica.get(Left).kept == [lockD1], sigLockRanks(replica.get(Left)) == [], no_release_while_signed_live })
    .then(releaseHold(Left))
    .expect(and { replica.get(Left).kept == [], replica.get(Left).refused == [lockD1], no_tx_lost, not(relBad), safe })

  // Or the deadline and the reserve pass on the releasing side's own clock: the lock (deadline 1) can no longer be paid by a secret revealed in time, so the proof holds
  // nothing worth keeping a hold for. At its clock 2 (= deadline + reserve) the hold is still kept; at 3 it is released, with no frame above it.
  run releaseWaitsForTheDeadlineAndTheReserveTest = lockRefused
    .then(tick(Left)).then(tick(Left))
    .expect(and { clock.get(Left) == 2, not(releasable(replica.get(Left), clock.get(Left), lockD1)), isOpen(replica.get(Left)) })
    .then(tick(Right)).then(tick(Left))
    .expect(and { clock.get(Left) == 3, releasable(replica.get(Left), clock.get(Left), lockD1) })
    .then(releaseHold(Left))
    .expect(and { replica.get(Left).refused == [lockD1], replica.get(Left).kept == [], isOpen(replica.get(Left)), replica.get(Left).height == 1, not(relBad), no_tx_lost, safe })

  // Only a lock held by a signed proof waits: every other tx is released at once (nothing signed holds it), and so is a lock that was never signed.
  run onlyALockInASignedProofWaitsTest = init.expect({
    val lock = lockD1
    val r = { ...EMPTY_REPLICA, sigLocks: [{ tx: lock, rank: 5 }] }
    val pay = Pay({ from: Left, amount: 1 })
    val a = withNotice(r, [pay, lock])
    val b = withNotice(EMPTY_REPLICA, [lock])
    and {
      a.refused == [pay], a.kept == [lock],
      b.refused == [lock], b.kept == [],
      not(releasable(r, 2, lock)), releasable(r, 3, lock), releasable({ ...r, sigLocks: [] }, 0, lock), releasable(r, 0, pay)
    }
  })

  // A commit supersedes the proofs below its rank and no others: a lock in a proof at rank 5 survives a commit at rank 4 and goes with one at rank 6; the commit's own proof
  // is the committed state, not a live proof.
  run commitSupersedesOnlyLowerRanksTest = init.expect({
    val r = { ...EMPTY_REPLICA, sigLocks: [{ tx: lockD1, rank: 5 }] }
    val low = { ...NO_FRAME, height: 1, nonce: 2, author: Right }               // rank 4
    val same = { ...NO_FRAME, height: 1, nonce: 2, author: Left }               // rank 5: the proof itself committed
    val high = { ...NO_FRAME, height: 1, nonce: 3, author: Right }              // rank 6
    and {
      commit(r, Left, 1, low).sigLocks.length() == 1,
      commit(r, Left, 1, same).sigLocks.length() == 0,
      commit(r, Left, 1, high).sigLocks.length() == 0,
      commit(r, Left, 1, high).sig == 6, commit(r, Left, 1, high).hi == 3
    }
  })

  // ---- R-COSIGN-FREEZE: after a side co-signs a settlement (or a reserve-to-collateral) it proposes nothing and refuses every peer frame, until the operation is over -------------

  // Both sides hold credit for each other, at height 2 with offdelta 0. Left co-signs a fold (offdelta 0 at height 2). Right's payment is refused with the retryable `frozen` (the
  // fold Left signed stands for the head: a frame that moved the offdelta would leave the chain a different balance than the Account), costs Right no tx, and goes through once
  // Left is released. A Left that took the frame would have a head whose offdelta is not the fold's (`cosign_fold_holds`; mutant `frozen-side-accepts-the-peer-frame`).
  action bothHoldCredit = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left)).then(deliverAck(Right, 1))
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 2 })))
    .then(propose(Left)).then(deliverProposal(Right, 2)).then(ackReceived(Right)).then(deliverAck(Left, 2))
  run cosignRefusesPeerFramesUntilReleasedTest = bothHoldCredit
    .then(cosign(Left))
    .expect(and { replica.get(Left).frozen, replica.get(Left).foldH == 2, replica.get(Left).fold == 0, cosign_fold_holds, safe })
    .then(enqueueTx(Right, Pay({ from: Right, amount: 1 })))
    .then(propose(Right)).then(deliverProposal(Left, 3))
    .expect(and {
      nacks.exists(x => x.fault == "frozen" and x.fid == 3), isOpen(replica.get(Left)), replica.get(Left).height == 2, replica.get(Left).tip.offdelta == 0,
      refusals == 1, cosign_fold_holds, no_bad_accept, safe
    })
    .then(deliverNack(Right, 3))
    .expect(and { isOpen(replica.get(Right)), replica.get(Right).mempool == [Pay({ from: Right, amount: 1 })], replica.get(Right).refused == [], replica.get(Right).attempt == 1, no_tx_lost, safe })
    .then(thaw(Left))
    .then(propose(Right)).then(deliverProposal(Left, 4)).then(ackReceived(Left)).then(deliverAck(Right, 4))
    .expect(and {
      replica.get(Left).height == 3, replica.get(Right).height == 3, replica.get(Left).tip == replica.get(Right).tip, replica.get(Left).tip.offdelta != 0,
      not(replica.get(Left).frozen), replica.get(Right).refused == [], no_tx_lost, safe
    })

  // The other way: a frozen side proposes nothing, whatever it has queued.
  run frozenSideProposesNothingTest = bothHoldCredit
    .then(cosign(Left))
    .then(enqueueTx(Left, Pay({ from: Left, amount: 1 })))
    .then(propose(Left)).fail()

  // A fold is co-signed at a head with nothing in flight: not with a frame proposed, not with one held (the frame would commit after the fold was signed).
  run cosignRefusedWhileAFrameIsInFlightTest = bothHoldCredit
    .then(enqueueTx(Left, Pay({ from: Left, amount: 1 })))
    .then(propose(Left))
    .then(cosign(Left)).fail()
  run cosignRefusedWhileAFrameIsHeldTest = bothHoldCredit
    .then(enqueueTx(Right, Pay({ from: Right, amount: 1 })))
    .then(propose(Right)).then(deliverProposal(Left, 3))
    .then(cosign(Left)).fail()
}
