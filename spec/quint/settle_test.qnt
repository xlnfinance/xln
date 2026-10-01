// Scenario tests for settle.qnt: an Account crossing an epoch boundary, each on an exact schedule.
// Run with: quint test settle_test.qnt --backend typescript
module settle_test {
  import chain.* from "./chain"
  import settle.* from "./settle"

  // Right is honest, Left is not. Each side has put 1 into collateral (collateral 2, ondelta 1), reserves 2 and 2.
  // Left pays 1 off-chain (offdelta -1), then Left offers to deposit 1 more (dl = -1).
  action lockRun =
    sinit(Right, 2, 2, 1, 1)
    .then(offPropose(Left, KPay({ from: Left, amt: 1 }))).then(ackPay)
    .then(offPropose(Left, KLock({ dl: -1, dr: 0 }))).then(ackLock)
  // the update, signed by both and executed: epoch 1 (custody moved, the offdelta folded into the ondelta)
  action settledRun =
    lockRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(execUpd(Left, 1))

  // ---- payments pause once an update is locked ------------------------------------------------------------------

  run paymentsPauseWhileLockedTest =
    lockRun
    .then(offPropose(Right, KPay({ from: Right, amt: 1 })))
    .fail()

  // ---- R-IMPLICIT-BASELINE: the next epoch opens with no ceremony -----------------------------------------------------

  // Custody moved and the offdelta was folded into the ondelta, so the implicit proof of epoch 1 (offdelta 0) pays exactly what both agreed.
  // Nobody has signed anything for the new epoch yet and nobody needs to: the honest side can close the Account at once, before it has even read the chain.
  run settlementOpensNextEpochTest =
    settledRun
    .expect(and { startable, exit_ok, hostage_free })
    .then(observe(Right))
    .expect(and {
      acct.epoch == 1, acct.coll == 3, acct.ondelta == 1, acct.nonce == 4,      // custody moved, the offdelta was folded
      money.res == Map(Left -> 1, Right -> 2),
      book == 0,
      acc.locked == 0, arena.get(acc.tip).epoch == 0,                           // the tip is still of epoch 0: the new epoch has no frame yet
      canStart({ ar: arena, a: acct, d: dispute }, Right, implicitProof(acct)),
      wsafe
    })

  // and the honest side closes the Account with the implicit proof: Delta = ondelta = 1 of collateral 3
  run implicitProofClosesTheAccountTest =
    settledRun
    .then(observe(Right))
    .then(cHonestDisputes(honestStart))
    .expect(dispute.rec0 == IMPLICIT)
    .then(cHonest(tick)).then(cHonest(tick)).then(cHonest(tick)).then(cHonest(tick))
    .then(cFinalize(honestFinalize))
    .expect(and { money.res == Map(Left -> 2, Right -> 4), acct.coll == 0, wsafe })

  // whichever proof the adversary starts with (the stale one or the locked state, chosen at random) and whatever nonce the finalize stores, the
  // Account can be closed again from the implicit proof of the new epoch
  run implicitStartAfterStaleFinalizeTest =
    lockRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(cNeutral(setOffline(true)))
    .then(cNeutral(adversaryStart))
    .then(cNeutral(tick)).then(cNeutral(tick)).then(cNeutral(tick)).then(cNeutral(tick))
    .then(cFinalize(adversaryFinalize))
    .then(cNeutral(setOffline(false)))
    .then(observe(Right))
    .expect(and { acct.epoch == 1, startable, wsafe })

  // The first signed proof of the epoch takes the stored nonce + 2 (the stored nonce is read from the chain: here the update's, 4), and the epoch's
  // own counter is gapless after it. Left pays 1 in the new epoch: nonce 6, offdelta -1 (it starts from 0, not from the old epoch's -1 folded already).
  run firstProofOfTheEpochIsStoredPlusTwoTest =
    settledRun
    .then(observe(Right)).then(observe(Left))
    .then(offPropose(Left, KPay({ from: Left, amt: 1 })))
    .expect(and { arena.get(prop.pid).nonce == acct.nonce + 2, arena.get(prop.pid).epoch == 1, arena.get(prop.pid).offdelta == -1 })
    .then(ackPay)
    .expect(and { arena.get(acc.tip).nonce == 6, book == -1, first_proof_at_stored_plus_two, wsafe })
    .then(offPropose(Left, KPay({ from: Left, amt: 1 })))
    .then(ackPay)
    .expect(and { arena.get(acc.tip).nonce == 7, book == -2, first_proof_at_stored_plus_two, wsafe })     // gapless after the first

  // The trap, from the Runtime's side. Left is honest; Right, which wants to open the implicit dispute later, offers the first proof of the epoch at
  // stored + 1 (a Right-authored one only ties the implicit proof). Left refuses to sign it. At stored + 2 it signs.
  run firstProofAtStoredPlusOneIsRefusedTest =
    sinit(Left, 2, 2, 1, 1)
    .then(offPropose(Right, KPay({ from: Right, amt: 1 }))).then(ackPay)
    .then(offPropose(Right, KLock({ dl: 0, dr: -1 }))).then(ackLock)
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(execUpd(Right, 1))
    .then(observe(Left)).then(observe(Right))
    .then(offProposeAdj(Right, KPay({ from: Right, amt: 1 }), 1))
    .expect(arena.get(prop.pid).nonce == acct.nonce + 1)
    .then(ackPay)
    .fail()
  run firstProofAtStoredPlusTwoIsSignedTest =
    sinit(Left, 2, 2, 1, 1)
    .then(offPropose(Right, KPay({ from: Right, amt: 1 }))).then(ackPay)
    .then(offPropose(Right, KLock({ dl: 0, dr: -1 }))).then(ackLock)
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(execUpd(Right, 1))
    .then(observe(Left)).then(observe(Right))
    .then(offPropose(Right, KPay({ from: Right, amt: 1 })))
    .then(ackPay)
    .expect(and { arena.get(acc.tip).nonce == acct.nonce + 2, first_proof_at_stored_plus_two, wsafe })

  // The first proof must continue from what both agreed (0 after the epoch event): a forged offdelta is not signed.
  run firstProofWithAForgedOffdeltaIsRefusedTest =
    sinit(Left, 2, 2, 1, 1)
    .then(offPropose(Right, KPay({ from: Right, amt: 1 }))).then(ackPay)
    .then(offPropose(Right, KLock({ dl: 0, dr: -1 }))).then(ackLock)
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(execUpd(Right, 1))
    .then(observe(Left)).then(observe(Right))
    .then(offProposeX(Right, KPay({ from: Right, amt: 1 }), 0, 1))
    .then(ackPay)
    .fail()

  // The stored nonce is READ from the chain, never derived from the Account's own frames. Right, honest, has an unacked proposal at nonce 3 (the
  // tip is 2); Left starts a dispute with it (Right signed it) and lets the window run out: a timeout finalize stores the start nonce plus 1 = 4. The
  // first proof of the new epoch is at 6 = 4 + 2 (a nonce derived from the tip, 2 + 2 = 4, would be dead on arrival).
  run firstProofReadsTheStoredNonceFromTheChainTest =
    sinit(Right, 2, 2, 1, 1)
    .then(offPropose(Left, KPay({ from: Left, amt: 1 }))).then(ackPay)
    .then(offPropose(Right, KPay({ from: Right, amt: 1 })))
    .then(cNeutral(startWith(Left, 3, false, 0, false)))
    .then(observe(Right))
    .then(cHonest(tick)).then(cHonest(tick)).then(cHonest(tick)).then(cHonest(tick))
    .then(cFinalize(finalizeWith(Left, 0, 0, false)))
    .then(observe(Right)).then(observe(Left))
    .expect(and { acct.epoch == 1, acct.nonce == 4, startable, wsafe })
    .then(abandon)                                  // Right's unacked proposal of epoch 0 lapses
    .then(offPropose(Left, KPay({ from: Left, amt: 1 })))
    .then(ackPay)
    .expect(and { arena.get(acc.tip).nonce == 6, arena.get(acc.tip).epoch == 1, first_proof_at_stored_plus_two, wsafe })

  // A finalize pays everything out and the new epoch starts from nothing: the agreed offdelta is reset, so the first payment of the new epoch is
  // judged from 0.
  run finalizeResetsTheBookTest =
    sinit(Right, 2, 2, 1, 1)
    .then(offPropose(Left, KPay({ from: Left, amt: 1 }))).then(ackPay)
    .then(cHonestDisputes(honestStart))
    .then(cHonest(tick)).then(cHonest(tick)).then(cHonest(tick)).then(cHonest(tick))
    .then(cFinalize(honestFinalize))
    .then(observe(Right)).then(observe(Left))
    .expect(book == 0)
    .then(offPropose(Left, KPay({ from: Left, amt: 1 })))
    .then(ackPay)
    .expect(and { book == -1, arena.get(acc.tip).epoch == 1, wsafe })

  // ---- a payment at a dead epoch is refused ---------------------------------------------------------------------------

  // A finalize opened epoch 1. Left, which has not read it, offers a payment for epoch 0: Right has read it and refuses.
  run deadEpochPaymentIsRefusedTest =
    sinit(Right, 2, 2, 1, 1)
    .then(cHonestDisputes(honestStart))
    .then(cHonest(tick)).then(cHonest(tick)).then(cHonest(tick)).then(cHonest(tick))
    .then(cFinalize(honestFinalize))
    .then(observe(Right))
    .then(offPropose(Left, KPay({ from: Left, amt: 1 })))
    .then(ackPay)
    .fail()

  // ---- a signed update does not survive another epoch event --------------------------------------------------------

  run updateDiesWithFinalizeTest =
    lockRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(cHonestDisputes(honestStart))
    .then(execUpd(Left, 1))
    .fail()
  // Left starts a dispute with the stale proof while Right is offline; Right loses, and the finalize opened epoch 1 at a
  // nonce below the update's. Only the epoch check stops the update now.
  run updateDiesAfterFinalizeTest =
    lockRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(cNeutral(setOffline(true)))
    .then(cNeutral(adversaryStart))
    .then(cNeutral(tick)).then(cNeutral(tick)).then(cNeutral(tick)).then(cNeutral(tick))
    .then(cFinalize(adversaryFinalize))
    .then(execUpd(Left, 1))
    .fail()
  // the implicit proof of the epoch a finalize opened is harmless: everything was paid out (collateral 0), so a dispute from it moves nothing
  run implicitStartAfterFinalizeIsHarmlessTest =
    lockRun
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(cHonestDisputes(honestStart))
    .then(cHonest(tick)).then(cHonest(tick)).then(cHonest(tick)).then(cHonest(tick))
    .then(cFinalize(honestFinalize))
    .then(observe(Right))
    .then(cNeutral(startImplicit(Left, implicitProof(acct), false, 0, false)))
    .expect(and { dispute.on, dispute.rec0 == IMPLICIT, acct.coll == 0, wsafe })

  // ---- an honest side that started a dispute stops signing at once -------------------------------------------------

  run disputeStarterStopsSigningTest =
    sinit(Right, 2, 2, 1, 1)
    .then(offPropose(Right, KPay({ from: Right, amt: 1 })))
    .then(cHonestDisputes(honestStart))
    .then(ackPay)
    .fail()

  // ---- what a settlement does to claims ------------------------------------------------------------------------------

  // a withdrawal: Right takes 1 out of the collateral into reserve; what each side would be paid on closing is unchanged
  run withdrawalKeepsClaimsTest =
    sinit(Right, 2, 2, 1, 1)
    .then(offPropose(Right, KLock({ dl: 0, dr: 1 }))).then(ackLock)
    .then(signUpd(Left, 1)).then(signUpd(Right, 1))
    .then(execUpd(Left, 1))
    .expect(and { acct.coll == 1, money.res == Map(Left -> 2, Right -> 3), claims_conserved, wsafe })
}
