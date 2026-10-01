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
  val expireNack: Refusal = refusalFor(3, 0, "not_expired", 0)

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
  // lock for deadline 1 is not after it (deadline_past, at index 1, behind a credit tx that applies). Left drops the lock (refused, the payer is released),
  // keeps the credit tx, and the next frame (attempt 1) commits.
  run nonRetryableFaultDropsTheNamedTxTest = init
    .then(enqueueTx(Right, SetCredit({ by: Right, limit: 2 })))
    .then(propose(Right)).then(deliverProposal(Left, 1)).then(ackReceived(Left)).then(deliverAck(Right, 1))
    .then(tick(Right))
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(enqueueTx(Left, HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 1 })))
    .then(propose(Left))
    .then(deliverProposal(Right, 2))
    .expect(and { nacks == Set(refusalFor(2, 1, "deadline_past", 0)), isOpen(replica.get(Right)), refusals == 1, isProposed(replica.get(Left)) })
    .then(deliverRefusal(Left, refusalFor(2, 1, "deadline_past", 0)))
    .expect(and {
      replica.get(Left).refused == [HtlcLock({ id: 1, payer: Left, amount: 1, hashlock: hashOf(1), deadline: 1 })],
      replica.get(Left).mempool == [SetCredit({ by: Left, limit: 1 })], replica.get(Left).attempt == 1, isOpen(replica.get(Left)), no_tx_lost, safe
    })
    .then(propose(Left))
    .then(deliverProposal(Right, 3))
    .then(ackReceived(Right)).then(deliverAck(Left, 3))
    .expect(and {
      replica.get(Left).height == 2, replica.get(Right).height == 2, replica.get(Left).tip == replica.get(Right).tip,
      replica.get(Left).tip.limitRight == 1, replica.get(Left).refused.length() == 1, replica.get(Left).submitted == 2, replica.get(Left).done == 1, no_tx_lost, safe
    })

  // (c) A refusal for a frame already committed is ignored: here from a peer that acked frame 1 and then refused it (a Byzantine receiver; an honest one never
  // does both). Left, Open, is unchanged; and with its next frame in flight it still keeps that frame (a refusal counts only for the pending frame).
  run refusalForACommittedFrameIsIgnoredTest = init
    .then(enqueueTx(Left, SetCredit({ by: Left, limit: 1 })))
    .then(propose(Left))
    .then(turnByzantine(Right)).then(byzAck(Right, true))
    .then(deliverAck(Left, 1))
    .then(byzNack(Right, 1, 0, "not_expired", 0))
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
    .then(turnByzantine(Right)).then(byzNack(Right, 1, 1, "bad_state", 3))
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
  // Right's 3) rolls its expiry back on the refusal; Right's frame, delivered to the now Open Left, commits on both sides; Left's expiry then goes out again.
  run rightKeepsItsFrameWhenItRefusesLeftsTest = lockedByRight
    .then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right)).then(tick(Left))
    .then(enqueueTx(Left, HtlcExpire({ id: 1 })))
    .then(enqueueTx(Right, Pay({ from: Right, amount: 1 })))
    .then(propose(Left)).then(propose(Right))
    .then(deliverProposal(Right, 2))                              // Right has frame 3 out: it refuses Left's expiry (its clock is 3) and keeps its own
    .expect(and { isProposed(replica.get(Right)), statusFid(replica.get(Right)) == 3, nacks == Set(refusalFor(2, 0, "not_expired", 0)), replica.get(Right).mempool == [], rollbacks == 0 })
    .then(deliverProposal(Left, 3))                               // Left keeps its own frame (Left wins a collision)
    .then(deliverRefusal(Left, refusalFor(2, 0, "not_expired", 0)))
    .then(deliverProposal(Left, 3))                               // Left is Open now and takes Right's frame
    .then(ackReceived(Left)).then(deliverAck(Right, 3))
    .expect(and { replica.get(Left).height == 2, replica.get(Right).height == 2, replica.get(Left).tip == replica.get(Right).tip, replica.get(Left).mempool == [HtlcExpire({ id: 1 })], no_tx_lost, safe })
    .then(tick(Right))
    .then(propose(Left)).then(deliverProposal(Right, 4)).then(ackReceived(Right)).then(deliverAck(Left, 4))
    .expect(and { replica.get(Left).height == 3, replica.get(Right).height == 3, not(replica.get(Right).tip.locks.get(1).on), refusals == 1, no_tx_lost, safe })

  // Left sends the expiry at attempts 0, 1 and 2 and Right (its view still behind) refuses each; the third refusal finds the retry budget spent (MAX_ATTEMPT = 2), so the
  // expiry is dropped with notice. This is the schedule of the fork the attempt number and the mark are there to prevent.
  action budgetSpent = lateExpiry
    .then(deliverRefusal(Left, expireNack))
    .then(propose(Left)).then(deliverProposal(Right, 4)).then(deliverRefusal(Left, refusalFor(4, 0, "not_expired", 1)))
    .then(propose(Left)).then(deliverProposal(Right, 5)).then(deliverRefusal(Left, refusalFor(5, 0, "not_expired", 2)))

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
      nacks.contains(refusalFor(5, 0, "not_expired", 2)), refusals == 4, no_bad_accept, no_orphan, safe
    })
    .then(deliverProposal(Right, 3)).then(deliverProposal(Right, 4))
    .expect(and {
      isOpen(replica.get(Right)), replica.get(Right).height == 2, nacks.contains(refusalFor(3, 0, "stale_attempt", 2)), nacks.contains(refusalFor(4, 0, "stale_attempt", 2)),
      replica.get(Left).height == 2, replica.get(Left).tip == replica.get(Right).tip, no_bad_accept, no_orphan, safe
    })
    .then(deliverRefusal(Left, refusalFor(3, 0, "stale_attempt", 2)))        // the answer reaches Left, which has nothing pending: ignored
    .expect(and { replica.get(Left).refused == [HtlcExpire({ id: 1 })], replica.get(Left).mempool == [], isOpen(replica.get(Left)), no_tx_lost })

  // (e) A frame below the mark is answered, with the mark (stale_attempt): the proposer moves its attempt to max(own, mark) + 1, keeps every tx (no notice) and the
  // retry costs none. Left restarted behind (`forgetAttempt`: the attempt counter went back to 0 while Right still remembers the mark 1); its next frame goes out at
  // attempt 2 and commits.
  action forgetAttempt(s: Side): bool = all {
    replica' = replica.set(s, { ...replica.get(s), attempt: 0 }),
    frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, nacks' = nacks, signed' = signed, clock' = clock, firstCommit' = firstCommit,
    diverged' = diverged, equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
  }

  run staleAttemptIsAnsweredWithTheMarkTest = lateExpiry
    .then(deliverRefusal(Left, expireNack))
    .then(propose(Left)).then(deliverProposal(Right, 4)).then(deliverRefusal(Left, refusalFor(4, 0, "not_expired", 1)))
    .then(forgetAttempt(Left))
    .then(propose(Left))
    .expect(frames.get(5).attempt == 0)
    .then(deliverProposal(Right, 5))
    .expect(and { nacks.contains(refusalFor(5, 0, "stale_attempt", 1)), replica.get(Right).mark == Declined({ attempt: 1, index: 0, fault: "not_expired" }), isOpen(replica.get(Right)) })
    .then(deliverRefusal(Left, refusalFor(5, 0, "stale_attempt", 1)))
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
    .then(deliverRefusal(Right, refusalFor(2, 0, "not_expired", 0)))
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
}
