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
      applyTx(locked, HtlcExpire({ id: 1 }), Left, 4) == Ok(funded),
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
}
