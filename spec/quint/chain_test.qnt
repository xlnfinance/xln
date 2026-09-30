// Scenario tests for chain.qnt: the dispute game on hand-made histories. Each states what the chain must do.
// Run with: quint test chain_test.qnt --backend typescript
module chain_test {
  import chain.* from "./chain"

  // ---- histories -------------------------------------------------------------------------------------------

  pure val EMPTY: int -> SignedProof = SLOTS.mapBy(_ => NO_PROOF)
  // an epoch-1 baseline that every epoch-0 event can be told apart from (slot 6)
  pure val BASE: int -> SignedProof = EMPTY.set(6, mkProof(true, 6, 1, true, 0, NO_CLAUSE, true, true))
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

  // After a finalize every proof of the old epoch is dead: replaying one is refused; the next epoch's baseline is not.
  // (nonce 4 is above the chain's nonce after the finalize, so only the epoch stops it)
  run oldEpochProofIsDeadTest =
    initFrom(BASE.set(1, pf(1, true, 0, true, true)).set(4, pf(4, true, -2, true, false)), Left, 0, 0, 2)
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .then(startWith(Right, 4, false, 0, false))
    .fail()
  run newEpochBaselineStartsTest =
    initFrom(BASE.set(1, pf(1, true, 0, true, true)), Left, 0, 0, 2)
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .then(startWith(Right, 6, false, 0, false))
    .expect(dispute.on and acct.epoch == 1)

  // A start that names a dead epoch is skipped: nothing moves, the nonce stays, and it is counted. The same start at the live epoch begins the dispute.
  run deadEpochStartIsSkippedTest =
    initFrom(BASE.set(1, pf(1, true, 0, true, true)).set(4, pf(4, true, -2, true, false)), Left, 0, 0, 2)
    .then(honestStart)
    .then(tick).then(tick).then(tick).then(tick)
    .then(honestFinalize)
    .then(startAtDeadEpoch(Right, 4))
    .expect(and { not(dispute.on), acct.epoch == 1, ghost.staleSkips == 1, p3_conserved, nonce_monotone })

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
    .expect(and { dispute.on, acct.epoch == 1, acct.nonce == 6, acct.ondelta == 0, ghost.staleSkips == 1 })

  // ---- debt is enforced before an outflow (Depository._enforceDebts) -------------------------------------------------------

  // A hand-made history: `s` holds `res` of reserve and owes `debt` to the other side (debt is a lazy claim: it was booked earlier, and reserve arrived since).
  action withDebt(s: Side, res: int, queue: List[int]): bool = all {
    money' = { res: money.res.set(s, res), debt: money.debt.set(s, sumOf(queue)), dq: money.dq.set(s, queue) },
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
      money.debt == Map(Left -> 2, Right -> 0), money.dq == Map(Left -> [2], Right -> []),
      not(ghost.debtBesideReserve), debt_means_broke, debt_queue_sums, safe
    })

  // Spendable reserve is reserve net of outstanding debt, never below zero (Depository._spendableReserve): the helper is pinned to the contract's definition.
  pure val OWES_SOME: Money = { res: Map(Left -> 2, Right -> 5), debt: Map(Left -> 1, Right -> 0), dq: Map(Left -> [1], Right -> []) }
  pure val OWES_ALL: Money = { res: Map(Left -> 1, Right -> 0), debt: Map(Left -> 3, Right -> 0), dq: Map(Left -> [3], Right -> []) }
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
      money.debt == Map(Left -> 3, Right -> 0), money.dq == Map(Left -> [1, 2], Right -> []),
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
}
