// Scenario tests for jbatch.qnt: what the chain does with the Entity's batches, and what the Entity does about it.
// Run with: quint test jbatch_test.qnt --backend typescript
module jbatch_test {
  import jbatch.* from "./jbatch"

  // op 1 a payment, op 2 a secret reveal, op 3 a dispute step, op 4 a payment
  pure def cat(arrPay: int, arrReveal: int, arrDisp: int): int -> Op = Map(
    1 -> { kind: Pay, amt: 1, arr: arrPay, dl: 0, gate: 0 },
    2 -> { kind: Reveal, amt: 0, arr: arrReveal, dl: arrReveal + LAG, gate: 0 },
    3 -> { kind: Disp, amt: 0, arr: arrDisp, dl: arrDisp + LAG, gate: 0 },
    4 -> { kind: Pay, amt: 1, arr: 7, dl: 0, gate: 0 }
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
    .expect(and { st.done.get(2), not(st.done.get(1)), st.gh.failed == 1, st.failedEv.get(1) == 1, st.failSeen.get(1) == 1, st.cnonce == 2, not(st.dropped.get(1)), nonce_final, safe })
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

  // A relayer that starves the call of gas does not burn the batch: the transaction reverts, the nonce stays open, the honest relayer's
  // next attempt lands it. Without the gas guard the payment batch would be failed at its nonce though it would have applied.
  run starvedBatchLandsLaterTest =
    initFrom(cat(1, 6, 6), 3)
    .then(arrive(1))
    .then(starve(0))
    .expect(and { st.cnonce == 0, st.gh.failed == 0, st.gh.reverts == 1, not(st.gh.burned) })
    .then(attempt(0))
    .expect(and { st.done.get(1), st.runs.get(1) == 1, st.cnonce == 1, safe })

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

  // The Entity gives a signed draft up. The payment in it is not signed again while the batch can still land: that would run it twice.
  run abortedPaymentIsNotSignedAgainTest =
    initFrom(cat(1, 6, 6), 3)
    .then(arrive(1))
    .then(abort(0))
    .expect(and { st.sub.length() == 1, st.sub[0].aband, nonce_final, safe })
    .then(attempt(0))                      // the abandoned copy lands: the payment runs, once
    .then(tick)
    .expect(and { st.done.get(1), st.runs.get(1) == 1, st.sub.length() == 1, safe })

  // The same for a payment whose aborted batch fails: the Entity signs it again only once the nonce is used and it has read BatchFailed.
  run abortedPaymentWaitsForBatchFailedTest =
    initFrom(cat(1, 6, 6), 1)
    .then(arrive(1))
    .then(drain(1))
    .then(abort(0))
    .expect(and { st.sub.length() == 1 })   // the batch is still alive: nothing new is signed
    .then(attempt(0))                      // fails at nonce 1, BatchFailed is read
    .expect(and { st.gh.failed == 1, st.failSeen.get(1) == 1, st.sub.length() == 2, st.sub[1].b.nonce == 2, st.sub[1].b.ids == Set(1), safe })

  // An urgent op is idempotent (it runs once or is skipped): after an abort it goes back into the draft at once, at a fresh nonce. If
  // both copies land the reveal has still run once.
  run abortedRevealIsSignedAtOnceTest =
    initFrom(cat(6, 1, 6), 3)
    .then(arrive(2))
    .then(abort(0))
    .expect(and { st.sub.length() == 2, st.sub[1].b.nonce == 2, st.sub[1].b.ids == Set(2), nonce_final, safe })
    .then(attempt(0)).then(attempt(1))
    .expect(and { st.done.get(2), st.runs.get(2) == 1, safe })

  // op 1 a payment, op 2 a secret reveal, op 3 a dispute step, op 4 a deposit leg
  pure def catD(arrDep: int, arrReveal: int, arrPay: int): int -> Op = Map(
    1 -> { kind: Pay, amt: 1, arr: arrPay, dl: 0, gate: 0 },
    2 -> { kind: Reveal, amt: 0, arr: arrReveal, dl: arrReveal + LAG, gate: 0 },
    3 -> { kind: Disp, amt: 0, arr: 7, dl: 8, gate: 0 },
    4 -> { kind: Dep, amt: 1, arr: arrDep, dl: 0, gate: 0 }
  )

  // op 1 a settlement (it carries the counterparty's signature at an account epoch)
  pure def catS(arrSettle: int): int -> Op = Map(
    1 -> { kind: Settle, amt: 0, arr: arrSettle, dl: 0, gate: 0 },
    2 -> { kind: Reveal, amt: 0, arr: 7, dl: 8, gate: 0 },
    3 -> { kind: Disp, amt: 0, arr: 7, dl: 8, gate: 0 },
    4 -> { kind: Pay, amt: 1, arr: 7, dl: 0, gate: 0 }
  )

  // J5 refinement: the deposit leg runs first, so it funds the payment behind it. They do not share a batch: the deposit goes alone and
  // the payment follows at the next nonce.
  run depositFundsThePaymentBehindItTest =
    initFrom(catD(1, 6, 1), 0)
    .then(arriveDue)
    .expect(and { st.sub.length() == 1, st.sub[0].b.ids == Set(4) })
    .then(attempt(0))
    .expect(and { st.done.get(4), st.reserve == 1, st.sub.length() == 2, st.sub[1].b.ids == Set(1), st.sub[1].b.nonce == 2 })
    .then(attempt(1))
    .expect(and { st.done.get(1), st.reserve == 0, st.cnonce == 2, safe })

  // J5 refinement: a batch with a deposit leg that cannot land (the token is paused) reverts whole and keeps its nonce open. It does
  // not soft-fail: nobody can burn its nonce. When the token works again the same batch lands.
  run failedDepositBatchRevertsWholeTest =
    initFrom(catD(1, 6, 1), 0)
    .then(arrive(4))
    .then(extLose)
    .then(attempt(0))
    .expect(and { st.cnonce == 0, st.gh.reverts == 1, st.gh.failed == 0, not(st.gh.depBurned), st.failedEv.get(4) == 0, not(st.done.get(4)), safe })
    .then(extBack)
    .then(attempt(0))
    .expect(and { st.cnonce == 1, st.done.get(4), safe })

  // The cost of that rule: a deposit batch that cannot land holds every batch above it. An urgent op behind it misses its deadline, and the
  // model records it apart (`hostage`), because the Entity cannot help it: the token is not the Entity's. The Entity can only keep deposit
  // legs out of signed batches when it can (a direct deposit takes no nonce), or sign them only when nothing urgent can arrive.
  run stuckDepositBatchHoldsAnUrgentOpTest =
    initFrom(catD(1, 2, 6), 0)
    .then(arrive(4))
    .then(extLose)
    .then(attempt(0))
    .then(tick)                            // now 2
    .then(arrive(2))                       // the reveal goes to nonce 2
    .then(attempt(0)).then(attempt(1))     // both revert: nonce 1 is not landed, nonce 2 is not next
    .then(tick)                            // now 3: the reveal's deadline
    .then(tick)
    .expect(and { st.gh.hostage, not(st.gh.missed), not(st.done.get(2)), st.cnonce == 0 })
    .then(extBack)
    .then(attempt(0)).then(attempt(1))
    .expect(and { st.done.get(4), st.done.get(2), st.cnonce == 2 })

  // J5 refinement: a settlement signed by the counterparty at an old account epoch (its signature is bad now) is a soft fail: the batch
  // takes its nonce, applies nothing and emits BatchFailed. The Entity drops the settlement (it needs a fresh co-signature: a new op).
  run staleSettlementFailsSoftTest =
    initFrom(catS(1), 3)
    .then(arrive(1))
    .then(poison(1))
    .then(attempt(0))
    .expect(and { st.cnonce == 1, st.gh.failed == 1, st.failedEv.get(1) == 1, not(st.done.get(1)), st.dropped.get(1), safe })

  // Only a failure of the batch's own authorisation reverts without taking the nonce.
  run forgedBatchTakesNoNonceTest =
    initFrom(catS(6), 3)
    .then(forge)
    .expect(and { st.cnonce == 0, st.gh.reverts == 1, not(st.gh.forgedLanded), safe })

  // A relayer sends the higher batch first: the chain refuses it (E2), and the honest attempts still land both in order.
  run outOfOrderRelayerIsRefusedTest =
    initFrom(cat(1, 1, 6), 3)
    .then(arrive(1)).then(arrive(2))
    .then(attemptAny(1))
    .expect(and { st.cnonce == 0, st.gh.reverts == 1, not(st.done.get(2)), safe })
    .then(attempt(0)).then(attempt(1))
    .expect(and { st.cnonce == 2, st.done.get(1), st.done.get(2), nonce_sequential, safe })

  // The chain runs the deposit legs of a batch before its payments, whatever the Entity packs: a batch signed with both (a bad Entity, or
  // an older one) still lands when the deposit covers the payment. The Entity itself never packs them together.
  action signOne(i: int): bool = st' = submit(st, [{ nonce: 1, ids: Set(i) }])
  action signBoth: bool = st' = submit(st, [{ nonce: 1, ids: Set(1, 4) }])

  run depositLegsRunBeforePaymentsTest =
    initFrom(catD(1, 6, 6), 0)
    .then(signBoth)
    .then(attempt(0))
    .expect(and { st.done.get(1), st.done.get(4), st.reserve == 0, st.cnonce == 1, st.gh.reverts == 0, safe })

  // op 1 a settlement on Account 1, op 4 a settlement on Account 2
  pure def catSS(arr: int): int -> Op = Map(
    1 -> { kind: Settle, amt: 0, arr: arr, dl: 0, gate: 0 },
    2 -> { kind: Reveal, amt: 0, arr: 7, dl: 8, gate: 0 },
    3 -> { kind: Disp, amt: 0, arr: 7, dl: 8, gate: 0 },
    4 -> { kind: Settle, amt: 0, arr: arr, dl: 0, gate: 0 }
  )

  // R-COSIGN: a batch that carries a co-signed op carries ops for that one Account only. Two settlements on two Accounts, and a payment,
  // reach the Entity together: each goes in a batch of its own, one after the other.
  // op 1 a settlement, op 4 a payment, both reaching the Entity at once
  pure def catSP(arr: int): int -> Op = Map(
    1 -> { kind: Settle, amt: 0, arr: arr, dl: 0, gate: 0 },
    2 -> { kind: Reveal, amt: 0, arr: 7, dl: 8, gate: 0 },
    3 -> { kind: Disp, amt: 0, arr: 7, dl: 8, gate: 0 },
    4 -> { kind: Pay, amt: 1, arr: arr, dl: 0, gate: 0 }
  )

  // R-COSIGN: a batch that carries a co-signed op carries ops for that one Account only. A settlement and a payment reach the Entity together:
  // the settlement goes alone, the payment follows at the next nonce.
  run coSignedOpsTravelAloneTest =
    initFrom(catSP(1), 3)
    .then(arriveDue)
    .expect(and { st.sub.length() == 1, st.sub[0].b.ids == Set(1), cosign_alone })
    .then(attempt(0))
    .expect(and { st.done.get(1), st.sub.length() == 2, st.sub[1].b.ids == Set(4), cosign_alone, safe })

  run coSignedOpsOfTwoAccountsDoNotShareABatchTest =
    initFrom(catSS(1), 3)
    .then(arriveDue)
    .expect(and { st.sub.length() == 1, st.sub[0].b.ids == Set(1), cosign_alone })
    .then(attempt(0))
    .expect(and { st.sub.length() == 2, st.sub[1].b.ids == Set(4), st.sub[1].b.nonce == 2, cosign_alone, safe })

  // J6 (coordinator): the Runtime signs a deposit batch only after simulating it successfully. While the token is paused nothing is signed;
  // when it works again the deposit goes out at once. A token paused after the signing still stalls the nonce (stuckDepositBatchHoldsAnUrgentOpTest).
  run depositIsNotSignedWhileTheTokenIsPausedTest =
    initFrom(catD(1, 6, 6), 0)
    .then(extLose)
    .then(arrive(4))
    .expect(st.sub.length() == 0)
    .then(extBack)
    .expect(and { st.sub.length() == 1, st.sub[0].b.ids == Set(4), safe })

  // Signed gas budget (coordinator): the relayer gave the whole budget and the batch failed inside it (out of gas, a gas-burning callee). It is
  // BatchFailed with the nonce spent and nothing applied; the payment is signed again at the next nonce once the Entity has read the event.
  run gasFailInsideTheBudgetSpendsTheNonceTest =
    initFrom(cat(1, 6, 6), 3)
    .then(arrive(1))
    .then(gasFail(0))
    .expect(and { st.cnonce == 1, st.gh.failed == 1, st.gh.gasFails == 1, st.failedEv.get(1) == 1, not(st.done.get(1)), not(st.gh.burned), st.sub.length() == 2, st.sub[1].b.nonce == 2, safe })
    .then(attempt(1))
    .expect(and { st.cnonce == 2, st.done.get(1), st.runs.get(1) == 1, safe })

  // The same failure on an urgent batch: the reveal is signed again at a fresh nonce and lands within its deadline when the retry is prompt.
  run gasFailOnAnUrgentBatchIsSignedAgainTest =
    initFrom(cat(6, 1, 6), 3)
    .then(arrive(2))
    .then(gasFail(0))
    .then(tick)
    .then(attempt(1))
    .expect(and { st.cnonce == 2, st.done.get(2), st.runs.get(2) == 1, not(st.gh.missed), safe })

  // A relayer that supplies less than the budget takes no nonce, and the batch lands later on a full budget.
  run underBudgetRelayerTakesNoNonceTest =
    initFrom(cat(1, 6, 6), 3)
    .then(arrive(1))
    .then(starve(0))
    .expect(and { st.cnonce == 0, st.gh.reverts == 1, st.gh.failed == 0, safe })
    .then(attempt(0))
    .expect(and { st.cnonce == 1, st.done.get(1), safe })

  // Time-gated op (Runtime rule): a dispute finalize is not signed before its gate opens, and is signed the tick it does.
  pure def catGate(gate: int): int -> Op = Map(
    1 -> { kind: Pay, amt: 1, arr: 7, dl: 0, gate: 0 },
    2 -> { kind: Reveal, amt: 0, arr: 7, dl: 8, gate: 0 },
    3 -> { kind: Disp, amt: 0, arr: 1, dl: gate + LAG, gate: gate },
    4 -> { kind: Pay, amt: 1, arr: 7, dl: 0, gate: 0 }
  )
  run gatedOpIsNotSignedBeforeItsGateTest =
    initFrom(catGate(2), 3)
    .then(arrive(3))
    .expect(and { st.sub.length() == 0, gate_respected })
    .then(tick)
    .expect(and { st.sub.length() == 1, st.sub[0].b.ids == Set(3), gate_respected })
    .then(attempt(0))
    .expect(and { st.done.get(3), not(st.gh.early), safe })

  // A gated batch that reaches the chain early reverts and keeps its nonce (the signed bytes of a batch signed early are injected here).
  run earlyGatedBatchRevertsTest =
    initFrom(catGate(3), 3)
    .then(arrive(3))
    .then(signOne(3))
    .expect(and { st.sub.length() == 1 })
    .then(attempt(0))
    .expect(and { st.cnonce == 0, st.gh.reverts >= 1, st.gh.early, not(gate_respected) })

  // The chain's gas cap: a batch above it can never land (a settlement costs two units, a payment one). The Entity never signs one; a batch injected
  // here reverts and stays at its nonce for ever, which is why the Runtime splits (SPLIT_AT_CAP).
  run overCapBatchNeverLandsTest =
    initFrom(catSP(1), 3)
    .then(arrive(1)).then(arrive(4))
    .expect(within_cap)
    .then(signBoth)
    .expect(st.sub.length() == 2)
    .then(attemptAny(1))
    .expect(st.cnonce == 0).expect(st.gh.reverts >= 1).expect(not(within_cap))

  // `firstChunk` is never exercised by the search (QUESTIONS J7 says so); a direct check of the pure function pins its behaviour.
  // Ops 1 and 4 are both settlements (cost 2 each, cap 2): one fits, the other goes to the next batch. Ops 1 and 4 as payments (cost 1) both fit.
  run firstChunkSplitsAtTheCapTest =
    initFrom(catSS(1), 0)
    .expect(and { firstChunk(st, Set(1, 4)) == Set(1), firstChunk(st, Set(4)) == Set(4), firstChunk(st, Set(1, 2, 4)) == Set(1) })
  run firstChunkKeepsCheapOpsTogetherTest =
    initFrom(cat(1, 7, 7), 0)
    .expect(and { firstChunk(st, Set(1, 4)) == Set(1, 4), firstChunk(st, Set(1, 2, 3, 4)) == Set(1, 2) })
  // the chunk is a prefix: an op that does not fit closes it, a cheaper op behind it does not jump the queue
  run firstChunkIsAPrefixTest =
    initFrom(Map(1 -> { kind: Pay, amt: 1, arr: 1, dl: 0, gate: 0 }, 2 -> { kind: Settle, amt: 0, arr: 1, dl: 0, gate: 0 },
                 3 -> { kind: Pay, amt: 1, arr: 1, dl: 0, gate: 0 }, 4 -> { kind: Pay, amt: 1, arr: 1, dl: 0, gate: 0 }), 0)
    .expect(firstChunk(st, Set(1, 2, 3)) == Set(1))

  // F8 (final review): a deposit that cannot be signed while the token is paused does not freeze the payments queued behind it. The payment goes out alone; the deposit is signed
  // at the next nonce once the token works and nothing is outstanding. Only the deposit waits.
  run paymentGoesOutBehindAPausedDepositTest =
    initFrom(catD(1, 7, 1), 3)
    .then(extLose)
    .then(arrive(4)).then(arrive(1))
    .expect(and { st.sub.length() == 1, st.sub[0].b.ids == Set(1), st.sub[0].b.nonce == 1 })
    .then(extBack)
    .then(attempt(0))
    .expect(and { st.cnonce == 1, st.done.get(1), st.sub.length() == 2, st.sub[1].b.ids == Set(4), st.sub[1].b.nonce == 2, safe })
    .then(attempt(1))
    .expect(and { st.cnonce == 2, st.done.get(4), safe })
  // J6c: the deposit funds the payment behind it (reserve 0). While the token is paused the payment is not signed unfunded; when the token is back the deposit goes, then the payment.
  run unfundedPaymentWaitsForThePausedDepositTest =
    initFrom(catD(1, 7, 1), 0)
    .then(extLose)
    .then(arrive(4)).then(arrive(1))
    .expect(and { st.sub.length() == 0, st.gh.failed == 0 })
    .then(extBack)
    .expect(and { st.sub.length() == 1, st.sub[0].b.ids == Set(4) })
    .then(attempt(0))
    .expect(and { st.sub.length() == 2, st.sub[1].b.ids == Set(1), st.sub[1].b.nonce == 2 })
    .then(attempt(1))
    .expect(and { st.done.get(1), st.cnonce == 2, st.gh.failed == 0, safe })
}
