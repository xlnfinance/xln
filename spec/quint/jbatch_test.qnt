// Scenario tests for jbatch.qnt: what the chain does with the Entity's batches, and what the Entity does about it.
// Run with: quint test jbatch_test.qnt --backend typescript
module jbatch_test {
  import jbatch.* from "./jbatch"

  // op 1 a payment, op 2 a secret reveal, op 3 a dispute step, op 4 a payment
  pure def cat(arrPay: int, arrReveal: int, arrDisp: int): int -> Op = Map(
    1 -> { kind: Pay, amt: 1, arr: arrPay, dl: 0 },
    2 -> { kind: Reveal, amt: 0, arr: arrReveal, dl: arrReveal + LAG },
    3 -> { kind: Disp, amt: 0, arr: arrDisp, dl: arrDisp + LAG },
    4 -> { kind: Pay, amt: 1, arr: 7, dl: 0 }
  )

  // The plainest case: one payment, one batch, one nonce.
  run paymentLandsTest =
    initFrom(cat(1, 3, 3), 3)
    .then(arrive(1))
    .then(attempt(0))
    .expect(and { st.cnonce == 1, st.done.get(1), st.runs.get(1) == 1, safe })

  // An urgent op arrives while a payment batch is outstanding. It gets a batch of its own at a fresh nonce above the payment's, and
  // the payment batch is not touched (F1). Both land in one round, in nonce order.
  run urgentBehindAnOutstandingPaymentTest =
    initFrom(cat(1, 1, 3), 3)
    .then(arrive(1))                       // payment batch at nonce 1
    .then(arrive(2))                       // the reveal at nonce 2, not at 1
    .expect(and { st.sub.length() == 2, st.sub[0].b.nonce == 1, st.sub[1].b.nonce == 2, nonce_final })
    .then(attempt(0))
    .then(attempt(1))
    .then(tick)
    .expect(and { st.done.get(2), st.done.get(1), st.cnonce == 2, st.gh.reverts == 0, safe })

  // F1 and J5: the payment batch reverts (the reserve was drained after it was signed). It takes its nonce and applies nothing, so the
  // reveal behind it lands in the same round. The payment stays queued and is signed again at a fresh nonce, then lands.
  run revertedPaymentDoesNotBlockTheUrgentOpTest =
    initFrom(cat(1, 1, 3), 1)
    .then(arrive(1))
    .then(drain(1))
    .then(arrive(2))
    .then(attempt(0))                      // the payment batch fails: nonce 1 is used, nothing else happens
    .then(attempt(1))                      // the reveal lands at nonce 2
    .expect(and { st.done.get(2), not(st.done.get(1)), st.gh.failed == 1, st.cnonce == 2, not(st.dropped.get(1)), nonce_final, safe })
    .then(tick)
    .expect(and { st.sub.length() == 3, st.sub[2].b.nonce == 3, st.sub[2].b.ids == Set(1) })
    .then(refill(1))
    .then(attempt(2))
    .expect(and { st.done.get(1), st.runs.get(1) == 1, st.cnonce == 3, safe })

  // A dispute op whose game moved is skipped, and the reveal signed before it still runs (TOLERANT).
  run movedDisputeDoesNotTakeTheRevealDownTest =
    initFrom(cat(3, 1, 1), 3)
    .then(arrive(2)).then(arrive(3))
    .then(poison(3))
    .then(attempt(0))                      // the reveal at nonce 1
    .then(attempt(1))                      // the dispute op at nonce 2: its game moved, the op is skipped and the batch lands
    .then(tick)
    .expect(and { st.done.get(2), not(st.done.get(3)), st.dropped.get(3), st.cnonce == 2, safe })

  // J2: the skipped dispute op is announced by an event, and the Entity abandons the op on reading it: it does not wait for an
  // outcome (a DisputeStarted) that never comes, and does not sign the op again.
  run skippedStartIsReadFromTheEventTest =
    initFrom(cat(3, 3, 1), 3)
    .then(arrive(3))
    .then(poison(3))                       // a dispute is already open on the Account: the start cannot apply
    .then(attempt(0))                      // the batch lands, the start is skipped, DisputeOpSkipped is emitted
    .expect(and { st.skipped.get(3), st.dropped.get(3), not(st.done.get(3)), nothingAlive(st), st.sub.length() == 1, safe })

  // A signed batch never expires and anybody can send it again: the second landing is refused by the nonce (E2) and runs nothing.
  run resubmittedBatchIsHarmlessTest =
    initFrom(cat(1, 6, 6), 3)
    .then(arrive(1))
    .then(attempt(0))
    .then(attempt(0))
    .expect(and { st.done.get(1), st.runs.get(1) == 1, st.gh.reverts == 1, st.reserve == 2, safe })

  // F1: nothing is ever signed twice at one nonce, whatever arrives, in whatever order.
  run neverTwoBatchesForOneNonceTest =
    initFrom(cat(1, 1, 1), 3)
    .then(arrive(1)).then(arrive(2)).then(arrive(3))
    .expect(and { st.sub.length() == 3, nonce_final, safe })

  // The urgent op misses its deadline when nobody lets it through: time cannot move while a first attempt is owed.
  run timeWaitsForFirstAttemptTest =
    initFrom(cat(1, 1, 3), 3)
    .then(arrive(1)).then(arrive(2))
    .then(tick).then(tick)
    .fail()

  // Two urgent ops reach the Entity in one frame and share a batch; the dispute moves before it lands. The reveal still runs.
  run revealSurvivesAMovedDisputeInOneFrameTest =
    initFrom(cat(6, 1, 1), 3)
    .then(arriveDue)
    .then(poison(3))
    .then(attempt(0))
    .expect(and { st.done.get(2), st.dropped.get(3), st.sub.length() == 1, safe })

  // A dispute op is spoiled first, then a reveal arrives: the spoiled batch lands as a no-op and takes its nonce; the reveal's batch
  // sits above it and lands right behind it. Were the spoiled batch to revert and keep its nonce open (E2), the reveal would wait.
  run spoiledBatchDoesNotBlockTheNextOneTest =
    initFrom(cat(6, 2, 1), 3)
    .then(arrive(3))
    .then(poison(3))
    .then(attempt(0))                      // (1,{3}) lands as a no-op
    .then(tick)
    .then(arrive(2))                       // the reveal goes to nonce 2
    .then(attempt(1))                      // lands
    .expect(and { st.done.get(2), st.cnonce == 2, safe })
}
