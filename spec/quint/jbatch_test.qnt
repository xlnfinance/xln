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

  // An urgent op arrives while a payment batch is outstanding. The Entity signs an urgent batch at the same nonce and a follow-up at
  // the next one. The payment batch lands first: the same-nonce copy is dead, the follow-up carries the op inside LAG.
  run urgentBehindAnOutstandingPaymentTest =
    initFrom(cat(1, 1, 3), 3)
    .then(arrive(1))                       // payment batch at nonce 1
    .then(arrive(2))                       // the reveal: (1,{2}) and (2,{2})
    .then(attempt(0))                      // the payment lands first
    .then(attempt(1))                      // the replacement at nonce 1 reverts (E2)
    .then(attempt(2))                      // the follow-up lands
    .then(tick)
    .expect(and { st.done.get(2), st.done.get(1), st.cnonce == 2, st.gh.reverts == 1, safe })

  // The other order: the urgent replacement lands first, the payment batch is dead and the payment goes again, later.
  run urgentReplacementWinsTest =
    initFrom(cat(1, 1, 3), 3)
    .then(arrive(1))
    .then(arrive(2))
    .then(attempt(1))                      // (1,{2}) lands
    .then(attempt(0))                      // (1,{1}) reverts
    .then(attempt(2))                      // (2,{2}) lands as a no-op: the op ran already
    .expect(and { st.done.get(2), not(st.done.get(1)), st.runs.get(2) == 1, st.cnonce == 2, safe })

  // A dispute op whose game moved is skipped, and the reveal in the same batch still runs (TOLERANT).
  run movedDisputeDoesNotTakeTheRevealDownTest =
    initFrom(cat(3, 1, 1), 3)
    .then(arrive(2)).then(arrive(3))
    .then(poison(3))
    .then(attempt(0)).then(attempt(1))     // the reveal's pair at nonces 1 and 2
    .then(attempt(2))                      // the dispute op's batch at nonce 3: its game moved, the op is skipped and the batch lands
    .then(tick)
    .expect(and { st.done.get(2), not(st.done.get(3)), st.dropped.get(3), st.cnonce == 3, safe })

  // A payment the reserve cannot cover reverts and stays queued: the signed batch can still land, so it is not abandoned.
  run revertedPaymentIsKeptTest =
    initFrom(cat(1, 3, 3), 1)
    .then(arrive(1))
    .then(drain(1))
    .then(attempt(0))                      // reverts: reserve 0
    .then(refill(1))
    .then(attempt(0))                      // lands now
    .expect(and { st.done.get(1), st.runs.get(1) == 1, not(st.dropped.get(1)), st.gh.reverts == 1, safe })

  // A signed batch never expires: the reverted payment batch lands later, by anyone, after the Entity already asked for nothing else.
  run signedBatchLandsLaterTest =
    initFrom(cat(1, 6, 6), 1)
    .then(arrive(1))
    .then(drain(1))
    .then(attempt(0))
    .then(tick).then(tick).then(tick)
    .then(refill(1))
    .then(attempt(0))
    .expect(and { st.done.get(1), st.runs.get(1) == 1, safe })

  // Two batches signed for one nonce: exactly one lands.
  run oneNonceOneBatchTest =
    initFrom(cat(1, 1, 3), 3)
    .then(arrive(1)).then(arrive(2))
    .then(attempt(1))
    .then(attempt(0))
    .expect(and { st.cnonce == 1, st.gh.landed == 1, st.gh.reverts == 1 })

  // The urgent op misses its deadline when nobody lets it through: time cannot move while a first attempt is owed.
  run timeWaitsForFirstAttemptTest =
    initFrom(cat(1, 1, 3), 3)
    .then(arrive(1)).then(arrive(2))
    .then(tick).then(tick)
    .fail()

  // Two urgent ops reach the Entity in one frame and share a batch pair; the dispute moves before it lands. The reveal still runs.
  run revealSurvivesAMovedDisputeInOneFrameTest =
    initFrom(cat(6, 1, 1), 3)
    .then(arriveDue)
    .then(poison(3))
    .then(attempt(0)).then(attempt(1))
    .expect(and { st.done.get(2), st.dropped.get(3), safe })

  // A dispute op is spoiled first, then a reveal arrives: the reveal's batches sit above the spoiled ones, and a batch that reverts
  // would block them (E2), so the spoiled ones must land as no-ops (TOLERANT) for the reveal to run inside LAG.
  run spoiledBatchDoesNotBlockTheNextOneTest =
    initFrom(cat(6, 2, 1), 3)
    .then(arrive(3))
    .then(poison(3))
    .then(attempt(0))                      // (1,{3}) lands as a no-op
    .then(tick)
    .then(arrive(2))                       // the pair for the reveal goes above the live batch (2,{3})
    .then(attempt(1))                      // (2,{3}) lands as a no-op
    .then(attempt(2))                      // (3,{2}) lands
    .expect(and { st.done.get(2), st.cnonce == 3, safe })
}
