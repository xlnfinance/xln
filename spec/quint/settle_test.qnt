// Scenario tests for settle.qnt: an Account crossing an epoch boundary, each on an exact schedule.
// Run with: quint test settle_test.qnt --backend typescript
module settle_test {
  import chain.* from "./chain"
  import settle.* from "./settle"

  // Right is honest, Left is not. Each side has put 1 into collateral (collateral 2, ondelta 1), reserves 2 and 2.
  // Left pays 1 off-chain (offdelta -1), then Left offers to deposit 1 more (dl = -1).
  action presignRun =
    sinit(Right, true, 2, 2, 1, 1)
    .then(offPropose(Left, KPay({ from: Left, amt: 1 }))).then(ackPay)
    .then(offPropose(Left, KLock({ dl: -1, dr: 0 }))).then(ackLock)
  action rebaseRun =
    sinit(Right, false, 2, 2, 1, 1)
    .then(offPropose(Left, KPay({ from: Left, amt: 1 }))).then(ackPay)
    .then(offPropose(Left, KLock({ dl: -1, dr: 0 }))).then(ackLock)

  // ---- payments pause once an update is locked ------------------------------------------------------------------

  run paymentsPauseWhileLockedTest =
    presignRun
    .then(offPropose(Right, KPay({ from: Right, amt: 1 })))
    .fail()

  // ---- presign: the next epoch opens with no ceremony ---------------------------------------------------------------

  run presignSettlementOpensNextEpochTest =
    presignRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(execUpd(Left, 1))
    .then(observe(Right))
    .expect(and {
      acct.epoch == 1, acct.coll == 3, acct.ondelta == 1, acct.nonce == 4,      // custody moved, the offdelta was folded
      money.res == Map(Left -> 1, Right -> 2),
      book == 0,
      acc.locked == 0, arena.get(acc.tip).epoch == 1, arena.get(acc.tip).offdelta == 0,
      arena.get(acc.tip).nonce > acct.nonce,                                     // the decided nonce floor
      startable, exit_ok, wsafe
    })

  // and the honest side can close the Account at once with it
  run presignBaselineClosesTheAccountTest =
    presignRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(execUpd(Left, 1))
    .then(observe(Right))
    .then(cHonestDisputes(honestStart))
    .then(cHonest(tick)).then(cHonest(tick))
    .then(cFinalize(honestFinalize))
    .expect(and { money.res == Map(Left -> 2, Right -> 4), acct.coll == 0, wsafe })

  // whichever proof the adversary starts with (the stale baseline or the locked state, chosen at random) and whatever nonce
  // the finalize stores, the baseline still clears it and the Account can be closed again
  run presignBaselineStartsAfterStaleFinalizeTest =
    presignRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(cNeutral(setOffline(true)))
    .then(cNeutral(adversaryStart))
    .then(cNeutral(tick)).then(cNeutral(tick))
    .then(cFinalize(adversaryFinalize))
    .then(cNeutral(setOffline(false)))
    .then(observe(Right))
    .expect(and { acct.epoch == 1, arena.get(acc.tip).epoch == 1, arena.get(acc.tip).nonce > acct.nonce,
                  startable, baseline_clears, wsafe })

  // ---- N1 as decided: a window without a proof, closed by the Rebase ---------------------------------------------

  run rebaseLeavesAWindowWithoutAProofTest =
    rebaseRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(execUpd(Left, 1))
    .expect(and {
      acct.epoch == 1, acct.ondelta == 2,                                        // custody only: the offdelta is not folded
      not(startable), not(exit_ok),                                              // the honest side cannot close the Account
      not(w_hostage)
    })
  run rebaseClosesTheWindowTest =
    rebaseRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(execUpd(Left, 1))
    .then(observe(Right)).then(observe(Left))
    .then(offPropose(Right, KRebase({ off: -1 }))).then(ackRebase)
    .expect(and { startable, exit_ok, acc.locked == 0, arena.get(acc.tip).nonce == acct.nonce + 1, wsafe })
  // the baseline must carry exactly the offdelta both agreed
  run forgedBaselineIsRefusedTest =
    rebaseRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(execUpd(Left, 1))
    .then(observe(Right)).then(observe(Left))
    .then(offPropose(Left, KRebase({ off: 0 }))).then(ackRebase)
    .fail()

  // ---- a payment at a dead epoch is refused ---------------------------------------------------------------------------

  // A finalize opened epoch 1. Left, which has not read it, offers a payment for epoch 0: Right has read it and refuses.
  run deadEpochPaymentIsRefusedTest =
    sinit(Right, false, 2, 2, 1, 1)
    .then(cHonestDisputes(honestStart))
    .then(cHonest(tick)).then(cHonest(tick))
    .then(cFinalize(honestFinalize))
    .then(observe(Right))
    .then(offPropose(Left, KPay({ from: Left, amt: 1 })))
    .then(ackPay)
    .fail()

  // ---- a signed update does not survive another epoch event --------------------------------------------------------

  run updateDiesWithFinalizeTest =
    presignRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(cHonestDisputes(honestStart))
    .then(execUpd(Left, 1))
    .fail()
  // Left starts a dispute with the stale baseline while Right is offline; Right loses, and the finalize opened epoch 1 at a
  // nonce below the update's. Only the epoch check stops the update now.
  run updateDiesAfterFinalizeTest =
    presignRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(cNeutral(setOffline(true)))
    .then(cNeutral(adversaryStart))
    .then(cNeutral(tick)).then(cNeutral(tick))
    .then(cFinalize(adversaryFinalize))
    .then(execUpd(Left, 1))
    .fail()
  // the pre-signed baseline is harmless when a finalize, not the update, opened the epoch: everything was paid out
  run presignBaselineAfterFinalizeIsHarmlessTest =
    presignRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(cHonestDisputes(honestStart))
    .then(cHonest(tick)).then(cHonest(tick))
    .then(cFinalize(honestFinalize))
    .then(observe(Right))
    .then(cNeutral(adversaryStart))
    .expect(and { arena.get(acc.tip).epoch == acct.epoch, arena.get(acc.tip).offdelta == 0, acct.coll == 0, wsafe })

  // ---- an honest side that started a dispute stops signing at once -------------------------------------------------

  run disputeStarterStopsSigningTest =
    sinit(Right, true, 2, 2, 1, 1)
    .then(offPropose(Right, KPay({ from: Right, amt: 1 })))
    .then(cHonestDisputes(honestStart))
    .then(ackPay)
    .fail()

  // ---- what a settlement does to claims ------------------------------------------------------------------------------

  // a withdrawal: Right takes 1 out of the collateral into reserve; what each side would be paid on closing is unchanged
  run withdrawalKeepsClaimsTest =
    sinit(Right, true, 2, 2, 1, 1)
    .then(offPropose(Right, KLock({ dl: 0, dr: 1 }))).then(ackLock)
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(execUpd(Left, 1))
    .expect(and { acct.coll == 1, money.res == Map(Left -> 2, Right -> 3), claims_conserved, wsafe })
}
