// Scenario tests for chain.qnt: the dispute game on hand-made histories. Each states what the chain must do.
// Run with: quint test chain_test.qnt --backend typescript
module chain_test {
  import chain.* from "./chain"

  // ---- histories -------------------------------------------------------------------------------------------

  pure val EMPTY: int -> SignedProof = SLOTS.mapBy(_ => NO_PROOF)
  // the first signed frame of epoch 1, which every epoch-0 event can be told apart from (slot 6): nonce 7, stored + 2 or more whichever way epoch 1 opens
  pure val BASE: int -> SignedProof = EMPTY.set(6, mkProof(true, FIRST_NONCE_E1, 1, true, 0, NO_CLAUSE, true, true))
  // a proof of epoch 0: nonce, authored by Left?, offdelta, signed by Left?, signed by Right?
  pure def pf(n: int, la: bool, off: int, sl: bool, sr: bool): SignedProof = mkProof(true, n, 0, la, off, NO_CLAUSE, sl, sr)
  pure def withClause(p: SignedProof, payer: Side, amount: int, deadline: int): SignedProof =
    { ...p, clause: { on: true, payer: payer, amount: amount, deadline: deadline } }

  val stale = BASE.set(1, pf(1, true, 2, true, true)).set(2, pf(2, false, 1, true, true))

  // ---- the game ------------------------------------------------------------------------------------------------

  // Left starts with a stale proof that favours it. The honest Right answers with its newer both-signed state, and the
  // chain settles that one after the window.
  run staleStartIsCounteredTest =
    initFrom(stale, Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(honestCounter)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .expect(and {
      money.res == Map(Left -> 1, Right -> 1),              // Δ = 1: the collateral splits
      acct.nonce == 2, acct.epoch == 1, acct.coll == 0,
      dispute == NO_DISPUTE,
      safe
    })

  // The honest side has REACT ticks to answer (read the start, get the counter included), and time does not move past that
  // while it has a response to make.
  run timeWaitsForHonestResponseTest =
    initFrom(stale, Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(tick).then(tick)
    .then(tick)
    .fail()
  // The answer that lands last (REACT ticks after the start) still beats the timeout: the windows exceed REACT (C11).
  run lastMomentCounterStillWinsTest =
    initFrom(stale, Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(tick).then(tick)
    .then(honestCounter)
    .then(tick).then(tick)
    .then(honestFinalize)
    .expect(and { acct.nonce == 2, money.res == Map(Left -> 1, Right -> 1), safe })

  // A starter cannot cut the window short, and cannot use its own newer proof to close at once (path 2 is the
  // non-starter's).
  run starterCannotCloseEarlyTest =
    initFrom(stale, Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(finalizeWith(Left, 0, 0, false))
    .fail()
  run starterCannotUseNewerProofTest =
    initFrom(stale, Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(finalizeWith(Left, 2, 2, false))
    .fail()

  // The non-starter may close at once with a newer proof the starter signed.
  run nonStarterClosesWithNewerProofTest =
    initFrom(stale, Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(finalizeWith(Right, 2, 2, false))
    .expect(and { money.res == Map(Left -> 1, Right -> 1), acct.nonce == 2, safe })

  // Equal nonces: Left's proof outranks Right's (Left is the tie-break winner everywhere). Left starts with the proof Right
  // signed and lost the collision on; the honest Right answers with the Left-authored state of the same nonce.
  run leftWinsEqualNonceTest =
    initFrom(
      BASE.set(1, pf(1, true, 1, true, true)).set(5, pf(1, false, 2, false, true)),
      Right, 0, 0, 2)
    .then(startWith(Left, 5, false, 0, false))
    .then(honestCounter)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .expect(and { arena.get(1).nonce == arena.get(5).nonce, rank(arena.get(1)) > rank(arena.get(5)),
                  money.res == Map(Left -> 1, Right -> 1), safe })

  // The non-starter's answer must land inside the window.
  run counterAfterWindowRefusedTest =
    initFrom(stale, Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(setOffline(true))
    .then(tick).then(tick).then(tick).then(tick)
    .then(setOffline(false))
    .then(honestCounter)
    .fail()

  // A party that starts a dispute starts with its newest co-signed proof, never an older one: nobody answers, so the older
  // proof is what the chain would pay.
  run starterUsesNewestProofTest =
    initFrom(stale, Right, 0, 0, 2)
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .expect(and { money.res == Map(Left -> 1, Right -> 1), acct.nonce == 3, safe })

  // ---- epochs (C1) --------------------------------------------------------------------------------------------

  // After a finalize every proof of the old epoch is dead: replaying one is refused; the next epoch's own proofs are not.
  // (nonce 4 is above the chain's nonce after the finalize, so only the epoch stops it)
  run oldEpochProofIsDeadTest =
    initFrom(BASE.set(1, pf(1, true, 0, true, true)).set(4, pf(4, true, -2, true, false)), Left, 0, 0, 2)
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .then(startWith(Right, 4, false, 0, false))
    .fail()
  // The new epoch needs no ceremony: a dispute starts from the implicit proof (no signature, no arena slot, synthesized from the chain's state)
  // at the stored nonce + 1; the stored nonce is what the timeout finalize left (the start's 1, plus 1).
  run newEpochImplicitStartsTest =
    initFrom(BASE.set(1, pf(1, true, 0, true, true)), Left, 0, 0, 2)
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .expect(and { acct.epoch == 1, acct.nonce == 2 })
    .then(startImplicit(Right, implicitProof(acct), false, 0, false))
    .expect(and { dispute.on, dispute.rec0 == IMPLICIT, dispute.p0.nonce == 3, acct.nonce == 3, acct.epoch == 1, dispute.wl == MIN_WINDOW, dispute.wr == MIN_WINDOW, safe })

  // A start that names a dead epoch is skipped: nothing moves, the nonce stays, and it is counted. The same start at the live epoch begins the dispute.
  run deadEpochStartIsSkippedTest =
    initFrom(BASE.set(1, pf(1, true, 0, true, true)).set(4, pf(4, true, -2, true, false)), Left, 0, 0, 2)
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .then(startAtDeadEpoch(Right, 4))
    .expect(and { not(dispute.on), acct.epoch == 1, ghost.staleSkips == 1, p3_conserved, nonce_monotone })

  // ---- R-IMPLICIT-BASELINE: the implicit proof of an epoch ----------------------------------------------------------------------
  // Epoch 1 is opened by a finalize of epoch 0 at once (the non-starter closes on the starter's proof), so the clock has run no ticks: the window of
  // the implicit dispute (2 + 2 ticks) still fits in the run. Left is honest, Right starts the implicit disputes. The stored nonce is then 2
  // (the start's 1, plus 1), so the implicit proof sits at 3 = stored + 1 and a signed frame of the epoch at 3 is the one that ties or beats it.

  pure val E0: int -> SignedProof = EMPTY.set(1, pf(1, true, 0, true, true))
  // a proof of epoch 1: nonce, authored by Left?, offdelta, windows
  pure def pe(n: int, la: bool, off: int, wl: int, wr: int): SignedProof = mkProofW(true, n, 1, la, off, NO_CLAUSE, true, true, wl, wr)
  action epoch1(ar: int -> SignedProof): bool =
    initFrom(ar, Left, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(finalizeWith(Right, 0, 0, false))
  action implicitStart: bool = startImplicit(Right, implicitProof(acct), false, 0, false)

  // The implicit proof settles at Delta = ondelta, offdelta 0. Right deposits 2 into the collateral crediting itself (ondelta stays 0): at the
  // timeout Delta = 0 and Right takes the whole collateral back.
  run implicitStartSettlesAtOndeltaTest =
    epoch1(E0)
    .then(r2c(Right, Right, 2))
    .then(implicitStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(finalizeWith(Right, 0, 0, false))
    .expect(and { money.res == Map(Left -> 0, Right -> 2), acct.epoch == 2, acct.nonce == 4, ghost.implicitSettles == 1, safe })

  // A Left-authored signed frame at stored + 1 outranks the implicit proof (2 * nonce + 1 against 2 * nonce): the honest Left counters it and
  // the chain settles the frame, offdelta 1 over ondelta 1 (Right deposited 1 for Left): Delta 2 of collateral 1, Left takes it and Right pays 1 more.
  run leftAuthoredFrameOutranksImplicitTest =
    epoch1(E0.set(6, pe(3, true, 1, MIN_WINDOW, MIN_WINDOW)))
    .then(r2c(Right, Left, 1))
    .then(implicitStart)
    .then(honestCounter)
    .expect(and { dispute.counter == 6, rank(arena.get(6)) > rank(dispute.p0) })
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .expect(and { money.res == Map(Left -> 2, Right -> 0), acct.nonce == 3, safe })

  // THE TRAP. After a settlement (stored 2) Right signs the first frame of the epoch at stored + 1 = 3 with offdelta +2 (all of Left's collateral:
  // Right deposited 2). A Right-authored proof only TIES the implicit proof (the same rank), a tie is a refused counter, and Right, which opens the
  // implicit dispute, gets Delta = ondelta = 0: Left's 2 is lost. The property `p1_allowed` is what flags it; the Runtime rule prevents it.
  run rightAuthoredFrameAtStoredPlusOneTiesAndIsRefusedTest =
    epoch1(E0.set(6, pe(3, false, 2, MIN_WINDOW, MIN_WINDOW)))
    .then(r2c(Right, Right, 2))
    .then(implicitStart)
    .expect(rank(arena.get(6)) == rank(dispute.p0))
    .then(counterWith(Left, 6))
    .fail()
  // The same tie on the other door: the non-starter closes with the tying frame as its final body (path 2). A tie is refused there too.
  run rightAuthoredFrameAtStoredPlusOneIsRefusedAsAFinalBodyTest =
    epoch1(E0.set(6, pe(3, false, 2, MIN_WINDOW, MIN_WINDOW)))
    .then(r2c(Right, Right, 2))
    .then(implicitStart)
    .then(finalizeWith(Left, 2, 6, false))
    .fail()
  run theTrapLosesTheFramesValueTest =
    epoch1(E0.set(6, pe(3, false, 2, MIN_WINDOW, MIN_WINDOW)))
    .then(r2c(Right, Right, 2))
    .then(implicitStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(finalizeWith(Right, 0, 0, false))
    .expect(and { money.res == Map(Left -> 0, Right -> 2), not(p1_allowed) })       // Left's frame was worth 2; it received 0

  // The same Right-authored frame at stored + 2 = 4 counters: rank 8 against 6. Left gets what the frame says.
  run rightAuthoredFrameAtStoredPlusTwoCountersTest =
    epoch1(E0.set(6, pe(4, false, 2, MIN_WINDOW, MIN_WINDOW)))
    .then(r2c(Right, Right, 2))
    .then(implicitStart)
    .then(honestCounter)
    .expect(dispute.counter == 6)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .expect(and { money.res == Map(Left -> 2, Right -> 0), acct.nonce == 4, safe })

  // A deposit does not advance the epoch: every signed frame of the epoch stays valid (it can start a dispute), and an implicit dispute started
  // afterwards settles at the NEW ondelta (Right credits Left with 1: ondelta 1, collateral 1, Delta = 1: Left takes it).
  run depositInsideTheEpochKeepsTheFramesTest =
    epoch1(E0.set(6, pe(4, false, 1, MIN_WINDOW, MIN_WINDOW)))
    .then(r2c(Right, Left, 1))
    .expect(and { acct.epoch == 1, acct.ondelta == 1, acct.coll == 1, acct.nonce == 2 })
    .then(startWith(Right, 6, false, 0, false))
    .expect(and { dispute.on, dispute.rec0 == 6 })
  run depositThenImplicitSettlesAtTheNewOndeltaTest =
    epoch1(E0)
    .then(r2c(Right, Left, 1))
    .then(implicitStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(finalizeWith(Right, 0, 0, false))
    .expect(and { money.res == Map(Left -> 1, Right -> 1), safe })

  // Two disputes in a row: the epoch a finalize opened has a proof to dispute with, and so has the epoch after it. The stored nonce is read from
  // the chain each time (2, then the implicit start's 3 plus 1).
  run twoImplicitDisputesInARowTest =
    epoch1(E0)
    .then(implicitStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(finalizeWith(Right, 0, 0, false))
    .expect(and { acct.epoch == 2, acct.nonce == 4 })
    .then(implicitStart)
    .expect(and { dispute.on, dispute.p0.nonce == 5, acct.epoch == 2, safe })

  // Epoch 0 has no implicit proof: a fresh Account's first frames are its proofs, there is nothing to fall back to.
  run epoch0RefusesAnImplicitStartTest =
    initFrom(E0, Left, 0, 0, 2)
    .then(startImplicit(Right, implicitProof(acct), false, 0, false))
    .fail()

  // A non-canonical implicit proof is refused, one field at a time (each of these is accepted if its check is dropped).
  action notCanonical(f: SignedProof => SignedProof): bool = startImplicit(Right, f(implicitProof(acct)), false, 0, false)
  run implicitWithNonzeroOffdeltaIsRefusedTest = epoch1(E0).then(notCanonical(p => { ...p, offdelta: 1 })).fail()
  run implicitAuthoredByLeftIsRefusedTest = epoch1(E0).then(notCanonical(p => { ...p, leftAuthored: true })).fail()
  run implicitWithAClauseIsRefusedTest = epoch1(E0).then(notCanonical(p => { ...p, clause: { on: true, payer: Left, amount: 1, deadline: 3 } })).fail()
  run implicitWithALongerLeftWindowIsRefusedTest = epoch1(E0).then(notCanonical(p => { ...p, wl: MIN_WINDOW + 1 })).fail()
  run implicitWithALongerRightWindowIsRefusedTest = epoch1(E0).then(notCanonical(p => { ...p, wr: MIN_WINDOW + 1 })).fail()
  run implicitAtTheStoredNonceIsRefusedTest = epoch1(E0).then(notCanonical(p => { ...p, nonce: p.nonce - 1 })).fail()
  run implicitAboveStoredPlusOneIsRefusedTest = epoch1(E0).then(notCanonical(p => { ...p, nonce: p.nonce + 1 })).fail()
  // an implicit start carries no starter arguments and no counter-proof commitment
  run implicitWithStarterArgumentsIsRefusedTest =
    epoch1(E0).then(learn(Right)).then(startImplicit(Right, implicitProof(acct), true, 0, false)).fail()
  run implicitWithACounterCommitmentIsRefusedTest =
    epoch1(E0.set(6, pe(4, true, 1, MIN_WINDOW, MIN_WINDOW))).then(startImplicit(Right, implicitProof(acct), false, 6, false)).fail()
  // a proof with a signature is not the implicit one: a canonical-looking body signed only by its starter does not start a dispute
  run aBodySignedOnlyByItsStarterIsNotImplicitTest =
    epoch1(E0.set(6, { ...pe(3, false, 0, MIN_WINDOW, MIN_WINDOW), sigL: false }))
    .then(startWith(Right, 6, false, 0, false))
    .fail()
  // the starter of an implicit dispute that is already open cannot start another (one active dispute)
  run implicitStartNeedsNoOpenDisputeTest =
    epoch1(E0).then(implicitStart).then(implicitStart).fail()

  // ---- N3: windows may lengthen, never shorten ------------------------------------------------------------------------------------

  // Epoch 0 proofs with other windows: Left starts with the proof at 1 (windows 3 and 3); a newer proof of Left's own (nonce 2) shortens the left
  // window, one at nonce 3 the right window, one at nonce 4 lengthens both (4 and 4). Right, the non-starter, may answer only with the last.
  val W3 = EMPTY.set(1, { ...pf(1, true, 0, true, true), wl: 3, wr: 3 })
              .set(2, { ...pf(2, true, 0, true, true), wl: 2, wr: 3 })
              .set(3, { ...pf(3, true, 0, true, true), wl: 3, wr: 2 })
              .set(4, { ...pf(4, true, 0, true, true), wl: 4, wr: 4 })
  run counterThatShortensTheLeftWindowIsRefusedTest = initFrom(W3, Right, 0, 0, 2).then(startWith(Left, 1, false, 0, false)).then(counterWith(Right, 2)).fail()
  run counterThatShortensTheRightWindowIsRefusedTest = initFrom(W3, Right, 0, 0, 2).then(startWith(Left, 1, false, 0, false)).then(counterWith(Right, 3)).fail()
  run counterThatLengthensTheWindowsLandsTest =
    initFrom(W3, Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(counterWith(Right, 4))
    .expect(and { dispute.counter == 4, dispute.wl == 3, dispute.wr == 3, dispute.timeout == dispute.t0 + 6, windows_never_shortened, safe })      // the clock stays frozen from the start
  run nonStarterCannotCloseWithAShorterWindowTest = initFrom(W3, Right, 0, 0, 2).then(startWith(Left, 1, false, 0, false)).then(finalizeWith(Right, 2, 2, false)).fail()
  run nonStarterCannotCloseWithAShorterRightWindowTest = initFrom(W3, Right, 0, 0, 2).then(startWith(Left, 1, false, 0, false)).then(finalizeWith(Right, 2, 3, false)).fail()
  run nonStarterClosesWithALongerWindowTest =
    initFrom(W3, Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(finalizeWith(Right, 2, 4, false))
    .expect(and { acct.nonce == 4, acct.epoch == 1, windows_never_shortened, safe })
  // an implicit start names the floor, and a signed counter of the epoch may carry longer windows (it must, to be answerable at all)
  run signedCounterMayLengthenTheImplicitWindowsTest =
    epoch1(E0.set(6, pe(4, false, 0, MIN_WINDOW + 1, MIN_WINDOW + 2)))
    .then(implicitStart)
    .then(counterWith(Left, 6))
    .expect(and { dispute.counter == 6, dispute.wl == MIN_WINDOW, windows_never_shortened, safe })

  // ---- H1: an HTLC settled on chain is judged by the secret, and finalize waits for the deadline ------------------

  val hub = BASE.set(1, withClause(pf(1, true, 0, true, true), Left, 1, 4))

  // Right is the payee, does not know the secret, and cannot close while the deadline is open (H1).
  run finalizeWaitsForDeadlineTest =
    initFrom(hub, Right, 1, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(tick).then(tick)
    .then(finalizeWith(Right, 0, 0, false))
    .fail()
  // The boundary: at the tick of the deadline itself the clause is still open (the contract reads `block.timestamp <= revealedUntil`), so
  // finalize still waits; one tick later it does not (expiredClauseIsDroppedTest).
  run finalizeStillWaitsAtTheDeadlineTickTest =
    initFrom(hub, Right, 1, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(tick).then(tick).then(tick)
    .expect(now == 4)
    .then(finalizeWith(Right, 0, 0, false))
    .fail()
  // Past the deadline the payer keeps its money: the clause is dropped, offdelta stays 0.
  run expiredClauseIsDroppedTest =
    initFrom(hub, Right, 1, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(tick).then(tick).then(tick).then(tick)
    .then(finalizeWith(Right, 0, 0, false))
    .expect(and { money.res == Map(Left -> 1, Right -> 2), safe })
  // With the secret on chain in time, the payee is paid: Left's offdelta drops by the amount, Left owes 1 and pays it.
  run revealedClausePaysTest =
    initFrom(hub, Right, 1, 0, 2)
    .then(learn(Right))
    .then(publish(Right))
    .then(startWith(Left, 1, false, 0, false))
    .then(finalizeWith(Right, 0, 0, false))
    .expect(and { money.res == Map(Left -> 0, Right -> 3), money.debt == Map(Left -> 0, Right -> 0), safe })
  // The dispute may start after the deadline: what counts is when the secret reached the chain (E6 in QUESTIONS.md).
  run lateStartStillPaysARevealedClauseTest =
    initFrom(hub, Right, 1, 0, 2)
    .then(learn(Right))
    .then(publish(Right))
    .then(tick).then(tick).then(tick).then(tick)
    .then(startWith(Left, 1, false, 0, false))
    .then(finalizeWith(Right, 0, 0, false))
    .expect(and { money.res == Map(Left -> 0, Right -> 3), money.debt == Map(Left -> 0, Right -> 0), safe })
  // A secret shown after the deadline pays nobody: the payer keeps its money.
  run lateSecretPaysNothingTest =
    initFrom(hub, Right, 1, 0, 2)
    .then(tick).then(tick).then(tick).then(tick)
    .then(learn(Right))
    .then(publish(Right))
    .then(startWith(Left, 1, false, 0, false))
    .then(finalizeWith(Right, 0, 0, false))
    .expect(and { money.res == Map(Left -> 1, Right -> 2), safe })
  // A payee that learns the secret AT the deadline tick cannot be paid (its publish needs LAG and lands after the deadline), and the property does not
  // call that a miss: `p1_clause` reads "learned at least LAG before the deadline" (the deadline tolerance, C11).
  run secretLearnedAtTheDeadlineTickIsNotOwedTest =
    initFrom(hub, Right, 1, 0, 2)
    .then(tick).then(tick).then(tick)
    .expect(now == 4)
    .then(learn(Right))
    .then(tick)
    .then(publish(Right))
    .then(startWith(Left, 1, false, 0, false))
    .then(finalizeWith(Right, 0, 0, false))
    .expect(and { money.res == Map(Left -> 1, Right -> 2), p1_clause, safe })
  // The honest payee publishes within LAG of learning the secret: time waits for it.
  run payeePublishesWithinLagTest =
    initFrom(hub, Right, 1, 0, 2)
    .then(learn(Right))
    .then(tick)
    .then(tick)
    .fail()

  // ---- H2: a zero response window is refused --------------------------------------------------------------------

  run zeroWindowIsRefusedTest =
    initFrom(BASE.set(1, { ...pf(1, true, 0, true, true), wl: 0 }), Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .fail()

  // ---- money ---------------------------------------------------------------------------------------------------------

  // A payout the debtor's reserve cannot cover becomes debt, and only for the uncovered part.
  run shortfallBecomesDebtTest =
    initFrom(BASE.set(1, pf(1, true, -3, true, true)), Left, 1, 0, 1)
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .expect(and {
      money.res == Map(Left -> 0, Right -> 2),               // Right took the collateral (1) and Left's whole reserve (1)
      money.debt == Map(Left -> 2, Right -> 0),
      safe
    })

  // A deposit during a dispute is not lost: the proof only fixes offdelta, the chain reads collateral at finalize.
  run depositDuringDisputeCountsTest =
    initFrom(BASE.set(1, pf(1, true, 1, true, true)), Left, 0, 1, 2)
    .then(honestStart)
    .then(r2c(Right, Right, 1))
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .expect(and { money.res == Map(Left -> 1, Right -> 2), safe })   // Δ = 1 of collateral 3
  run depositForLeftRaisesOndeltaTest =
    initFrom(BASE.set(1, pf(1, true, 1, true, true)), Left, 0, 1, 2)
    .then(honestStart)
    .then(r2c(Right, Left, 1))
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .expect(and { money.res == Map(Left -> 2, Right -> 1), safe })   // ondelta 1: Δ = 2 of collateral 3

  // ---- an absent honest party -----------------------------------------------------------------------------------

  // If the honest party is offline for a whole window it can lose the game. That is not a protocol failure, and it is
  // recorded, so the invariants exclude it.
  run offlinePartyCanLoseTest =
    initFrom(stale, Right, 0, 0, 2)
    .then(setOffline(true))
    .then(startWith(Left, 1, false, 0, false))
    .then(tick).then(tick).then(tick).then(tick)
    .then(finalizeWith(Left, 0, 0, false))
    .expect(and { ghost.lostByAbsence, not(ghost.xWasOffline), money.res == Map(Left -> 2, Right -> 0), safe })   // the exclusion ends with the dispute

  // ---- boundaries and signatures the payout checks rest on -----------------------------------------------------------

  // A counter-proof must carry the starter's signature: the starter consented to it, or the chain would settle what it never saw.
  run counterNeedsTheStartersSignatureTest =
    initFrom(BASE.set(1, pf(1, true, 2, true, true)).set(2, pf(2, false, 1, false, true)), Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(counterWith(Right, 2))                 // signed by Right alone
    .fail()

  // The honest side may take the whole REACT ticks to answer, and its counter still lands: the windows exceed REACT (C11).
  run counterAtTheReactionDeadlineStillLandsTest =
    initFrom(stale, Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(REACT.reps(_ => tick))
    .then(honestCounter)
    .expect(and { dispute.counter != 0, safe })

  // A finalize-time secret of the non-starter counts on the deadline tick itself (the registry's rule is the same: `<= deadline`).
  run nonStarterSecretAtTheDeadlineTickPaysTest =
    initFrom(hub, Right, 1, 0, 2)
    .then(learn(Right))
    .then(setOffline(true))
    .then(tick).then(tick).then(tick)            // now is the clause's deadline
    .then(setOffline(false))
    .then(startWith(Left, 1, false, 0, false))
    .then(finalizeWith(Right, 0, 0, true))
    .expect(money.res == Map(Left -> 0, Right -> 3))

  // Only the non-starter supplies finalize-time evidence: a starter that knows the secret cannot.
  run starterCannotSupplyTheNonStartersEvidenceTest =
    initFrom(hub, Right, 1, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .then(tick).then(tick).then(tick).then(tick)
    .then(learn(Left))
    .then(finalizeWith(Left, 0, 0, true))
    .fail()

  // A dispute start needs a nonce above the stored one: a proof at the stored nonce (here 0, the fresh Account's) is refused.
  run startNeedsANonceAboveTheStoredOneTest =
    initFrom(BASE.set(1, pf(0, true, 0, true, true)), Right, 0, 0, 2)
    .then(startWith(Left, 1, false, 0, false))
    .fail()

  // "nothing moves" is asserted for the whole chain state, and with a dispute open in the live epoch (the skip must not touch it).
  run deadEpochSkipMovesNothingTest =
    initFrom(BASE.set(1, pf(1, true, 0, true, true)).set(4, pf(4, true, -2, true, false)), Left, 0, 0, 2)
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .then(startAtDeadEpoch(Right, 4))
    .expect(and { acct.nonce == 2, acct.epoch == 1, acct.coll == 0, acct.ondelta == 0, acct.via == 0, not(dispute.on), ghost.staleSkips == 1 })
  run deadEpochSkipLeavesALiveDisputeAloneTest =
    initFrom(BASE.set(1, pf(1, true, 0, true, true)).set(4, pf(4, true, -2, true, false)), Left, 0, 0, 2)
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .then(startWith(Right, 6, false, 0, false))
    .expect(and { dispute.on, acct.epoch == 1 })
    .then(startAtDeadEpoch(Right, 4))
    .expect(and { dispute.on, acct.epoch == 1, acct.nonce == FIRST_NONCE_E1, acct.ondelta == 0, ghost.staleSkips == 1 })

  // ---- debt is enforced before an outflow (Depository._enforceDebts) -------------------------------------------------------

  // A hand-made history: `s` holds `res` of reserve and owes `debt` to the other side (debt is a lazy claim: it was booked earlier, and reserve arrived since).
  action withDebt(s: Side, res: int, queue: List[int]): bool = all {
    money' = { ...money, res: money.res.set(s, res), debt: money.debt.set(s, sumOf(queue)), dq: money.dq.set(s, claimsOf(queue)) },
    total' = total - money.res.get(s) + res,
    arena' = arena, honest' = honest, now' = now, acct' = acct, dispute' = dispute, registry' = registry, knows' = knows,
    offline' = offline, applied' = applied, ghost' = ghost
  }

  // Left owes 1 and holds 2; a payout then leaves it 3 short. The old debt is paid out of the reserve first (1 to Right), then the reserve left (1) covers part of the new
  // shortfall, and the rest (2) is booked: Left ends with nothing and owes 2, Right holds the collateral (1), the old debt (1) and the part paid (1).
  // Without the enforcement Left would keep 1 of reserve and owe 3.
  run olderDebtIsEnforcedBeforeAShortfallTest =
    initFrom(BASE.set(1, pf(1, true, -3, true, true)), Left, 0, 0, 1)
    .then(withDebt(Left, 2, [1]))
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .expect(and {
      money.res == Map(Left -> 0, Right -> 3),
      money.debt == Map(Left -> 2, Right -> 0), money.dq == Map(Left -> claimsOf([2]), Right -> []),
      not(ghost.debtBesideReserve), debt_means_broke, debt_queue_sums, safe
    })

  // Spendable reserve is reserve net of outstanding debt, never below zero (Depository._spendableReserve): the helper is pinned to the contract's definition.
  pure val OWES_SOME: Money = { res: Map(Left -> 2, Right -> 5), debt: Map(Left -> 1, Right -> 0), dq: Map(Left -> claimsOf([1]), Right -> []), out: 0 }
  pure val OWES_ALL: Money = { res: Map(Left -> 1, Right -> 0), debt: Map(Left -> 3, Right -> 0), dq: Map(Left -> claimsOf([3]), Right -> []), out: 0 }
  run spendableIsReserveNetOfDebtTest =
    initFrom(BASE, Left, 0, 0, 1)
    .expect(and { spendable(OWES_SOME, Left) == 1, spendable(OWES_SOME, Right) == 5, spendable(OWES_ALL, Left) == 0 })

  // Everything Left holds is owed: it cannot move any of it into the collateral.
  run reserveThatIsOwedCannotBeDepositedTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(withDebt(Left, 2, [2]))
    .then(r2c(Left, Left, 1))
    .fail()

  // Depository._enforceDebts pays at most 32 queued claims a call, oldest first (DEBT_ENFORCE_MAX = 2 here). Left holds 3 and owes three claims of 1; a payout leaves it 2 short.
  // One call pays the first two claims (Right gets 2 more), the third stays queued, and the reserve left (1) is all owed: nothing is spendable, so the shortfall is booked whole (2), behind the
  // old claim. Left still holds reserve, because its queue did not fit in one call; it is not spendable.
  run enforcementReachesOnlyOneCallsWorthOfClaimsTest =
    initFrom(BASE.set(1, pf(1, true, -2, true, true)), Left, 0, 0, 1)
    .then(withDebt(Left, 3, [1, 1, 1]))
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .expect(and {
      money.res == Map(Left -> 1, Right -> 3),
      money.debt == Map(Left -> 3, Right -> 0), money.dq == Map(Left -> claimsOf([1, 2]), Right -> []),
      spendable(money, Left) == 0,
      not(ghost.debtBesideReserve), debt_means_broke, debt_queue_sums, p3_conserved, safe
    })

  // F15: a deposit enforces first. Left holds 3 and owes 1: the claim is paid out of the 3 (Right gets 1) and then Left deposits 1 of the 2 that are left.
  run depositPaysTheOlderDebtFirstTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(withDebt(Left, 3, [1]))
    .then(r2c(Left, Left, 1))
    .expect(and { money.res == Map(Left -> 1, Right -> 1), money.debt == Map(Left -> 0, Right -> 0), money.dq == Map(Left -> [], Right -> []), ghost.r2cOwes == false, debt_queue_sums, safe })

  // F15: what a long queue leaves is owed, not spendable. Left holds 3 and owes three claims of 1; one call pays two, the 1 that is left is owed to the third: it cannot be deposited.
  run longQueueReserveCannotBeDepositedTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(withDebt(Left, 3, [1, 1, 1]))
    .then(r2c(Left, Left, 1))
    .fail()

  // ---- older debts owed to third parties are enforced too, in order (R2C-DEBT-FIRST at the dispute payout; Arrival PR 108) --------------------------------------------------

  // Left's older claim is owed to a third party (another Account of the entity), not to Right. Enforcement pays it first, out of the reserve, and the peer gets none of it: Left holds 2 and
  // owes 1 to a third party; a payout then leaves it 3 short. The old claim is paid out (1 leaves the Account's reserves, kept in `out`), the reserve left (1) covers part of the new shortfall
  // (Right gets it), and the rest (2) is booked to Right. Right ends with the collateral (1) and the part paid (1).
  action withClaims(s: Side, res: int, queue: List[Claim]): bool = all {
    money' = { ...money, res: money.res.set(s, res), debt: money.debt.set(s, claimsSum(queue)), dq: money.dq.set(s, queue) },
    total' = total - money.res.get(s) + res,
    arena' = arena, honest' = honest, now' = now, acct' = acct, dispute' = dispute, registry' = registry, knows' = knows,
    offline' = offline, applied' = applied, ghost' = ghost
  }
  run olderThirdPartyDebtIsPaidOutBeforeAShortfallTest =
    initFrom(BASE.set(1, pf(1, true, -3, true, true)), Left, 0, 0, 1)
    .then(withClaims(Left, 2, [thirdClaim(1)]))
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .expect(and {
      money.res == Map(Left -> 0, Right -> 2), money.out == 1,
      money.debt == Map(Left -> 2, Right -> 0), money.dq == Map(Left -> [peerClaim(2)], Right -> []),
      p3_conserved, pay_exact, debt_queue_sums, safe
    })

  // ---- settlement debt forgiveness (R-SETTLE-FORGIVE; Arrival PR 108) --------------------------------------------------------------------------------------------------
  // `withQueues` is a hand-made history: what each side owes, oldest claim first. Reserves stay 0 (forgiveness moves none).
  action withQueues(qL: List[Claim], qR: List[Claim]): bool = all {
    money' = { ...money, debt: Map(Left -> claimsSum(qL), Right -> claimsSum(qR)), dq: Map(Left -> qL, Right -> qR) },
    total' = total, arena' = arena, honest' = honest, now' = now, acct' = acct, dispute' = dispute, registry' = registry, knows' = knows,
    offline' = offline, applied' = applied, ghost' = ghost
  }
  pure def P(a: int): Claim = peerClaim(a)
  pure def T(a: int): Claim = thirdClaim(a)

  // Both directions at the token's head: the claim at the head of each queue that is owed to the other side goes, nothing behind it (Left's head 1 and Right's head 2 go; Left's third-party
  // claim and Right's second claim stay). The totals follow.
  run forgivenessTakesOnlyTheHeadOfEachSideTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(withQueues([P(1), T(2)], [P(2), P(1)]))
    .then(settleForgiving([1]))
    .expect(and {
      money.dq == Map(Left -> [T(2)], Right -> [P(1)]), money.debt == Map(Left -> 2, Right -> 1),
      ghost.forgiven == 1, ghost.forgiveBoth == 1, ghost.forgiveReverts == 0,
      forgive_ok, debt_queue_sums, p3_conserved, safe
    })

  // Only the counterparty owes (nothing on Left's side): its head is forgiven all the same, the direction does not matter.
  run forgivenessWorksInTheOtherDirectionTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(withQueues([], [P(1), P(2)]))
    .then(settleForgiving([1]))
    .expect(and { money.dq == Map(Left -> [], Right -> [P(2)]), money.debt == Map(Left -> 0, Right -> 2), ghost.forgiven == 1, ghost.forgiveBoth == 0, forgive_ok, debt_queue_sums, safe })

  // A head owed to a third party is not the Account's to forgive: with nothing else to forgive and a debt there, the settlement reverts and nothing moves.
  run aThirdPartyHeadIsNotForgivenAndTheSettlementRevertsTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(withQueues([T(2), P(1)], []))
    .then(settleForgiving([1]))
    .expect(and {
      money.dq == Map(Left -> [T(2), P(1)], Right -> []), money.debt == Map(Left -> 3, Right -> 0),
      ghost.forgiven == 0, ghost.forgiveReverts == 1, forgive_ok, debt_queue_sums, safe
    })

  // Both heads are owed to third parties: nothing was forgiven and debts exist, so the settlement reverts (it does not land with nothing forgiven).
  run aSettlementThatForgivesNothingRevertsTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(withQueues([T(1)], [T(2)]))
    .then(settleForgiving([1]))
    .expect(and { money.dq == Map(Left -> [T(1)], Right -> [T(2)]), ghost.forgiven == 0, ghost.forgiveReverts == 1, forgive_ok, safe })

  // It reverts only when NOTHING was forgiven: Left's head is the Account's and goes, Right's head is a third party's and stays, and the settlement lands.
  run oneBlockedHeadDoesNotRevertTheSettlementTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(withQueues([P(1)], [T(2)]))
    .then(settleForgiving([1]))
    .expect(and {
      money.dq == Map(Left -> [], Right -> [T(2)]), money.debt == Map(Left -> 0, Right -> 2),
      ghost.forgiven == 1, ghost.forgiveMixed == 1, ghost.forgiveReverts == 0, forgive_ok, debt_queue_sums, safe
    })

  // With no debt anywhere there is nothing to forgive and nothing blocked: the settlement lands.
  run aSettlementWithNoDebtLandsTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(settleForgiving([1]))
    .expect(and { ghost.forgiveReverts == 0, ghost.forgiven == 0, forgive_ok, safe })

  // A token that is not listed is not touched, whatever its debts: the settlement lands and nothing is forgiven.
  run anUnlistedTokenIsLeftAloneTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(withQueues([P(1)], [P(2)]))
    .then(settleForgiving([2]))
    .expect(and { money.dq == Map(Left -> [P(1)], Right -> [P(2)]), ghost.forgiven == 0, ghost.forgiveReverts == 0, forgive_ok, safe })

  // At most the cap of ids (32 in the contract, FORGIVE_MAX = 2 here): the cap itself lands, one more reverts and nothing moves.
  run aSettlementAtTheCapLandsTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(withQueues([P(1)], [P(2)]))
    .then(settleForgiving([1, 2]))
    .expect(and { money.dq == Map(Left -> [], Right -> []), ghost.forgiven == 1, ghost.forgiveReverts == 0, forgive_ok, safe })
  run aSettlementOverTheCapRevertsTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(withQueues([P(1)], [P(2)]))
    .then(settleForgiving([1, 2, 3]))
    .expect(and { money.dq == Map(Left -> [P(1)], Right -> [P(2)]), ghost.forgiven == 0, ghost.forgiveReverts == 1, forgive_ok, safe })

  // A token listed twice reverts the settlement (it would be forgiven twice).
  run aTokenListedTwiceRevertsTest =
    initFrom(BASE, Left, 0, 0, 1)
    .then(withQueues([P(1), P(1)], [P(2)]))
    .then(settleForgiving([1, 1]))
    .expect(and { money.dq == Map(Left -> [P(1), P(1)], Right -> [P(2)]), ghost.forgiven == 0, ghost.forgiveReverts == 1, forgive_ok, safe })
}
