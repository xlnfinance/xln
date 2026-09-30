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
  // expiry is refused by the payee until the payee's own clock is past the deadline and the reserve, then accepted: no early expiry, and no deadlock.
  run expiryWaitsForTheReceiversOwnClockTest = atHeight2
    .then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right)).then(tick(Left)).then(tick(Right)).then(tick(Left))
    .then(enqueueTx(Left, HtlcExpire({ id: 1 })))                 // Left's clock is 4 > 2 + reserve 1
    .then(propose(Left))
    .then(deliverProposal(Right, 3))                              // Right's clock is 3, not past 3: refused
    .expect(and { refusals == 1, replica.get(Right).tip.locks.get(1).on, isProposed(replica.get(Left)), safe })
    .then(tick(Right))
    .then(deliverProposal(Right, 3))                              // the same frame, Right's clock is 4: accepted
    .then(ackReceived(Right)).then(deliverAck(Left, 3))
    .expect(and { not(replica.get(Right).tip.locks.get(1).on), replica.get(Left).height == 3, authority, safe })

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
}
