// The Account layer meets the chain: whatever RCPAN lets two parties co-sign, the chain's payout can honour within the credit granted.
//
// account_core says what a co-signed Body may look like (RCPAN: the allocation stays inside [-limitLeft, COLLATERAL + limitRight] in
// the worst case over every open clause). chain says what a settled proof pays (collateral to the winners, the rest a debt of the
// side that ends outside [0, collateral]). The Account layer's Proof has up to LOCK_SLOTS open clauses; the chain module holds
// one clause per proof, and the contract settles the clauses one by one, each adding its amount to the delta when its secret is
// on the chain in time, and finalizes only when every unrevealed clause is past its deadline (H1). So the only place the clauses
// interact is the sum: this test enumerates every Body in a small domain (no state machine needed: RCPAN is a predicate on the
// Body) and every outcome of its clauses, settles the sum with the chain's own `payout`, and checks what the parties were promised.
//
// Run with: quint test compose.qnt --backend typescript
module compose {
  import account_core as a from "./account_core"
  import chain as c from "./chain"

  pure val OFFS = (-4).to(6)
  pure val LIMS = 0.to(2)

  // a slot: empty, or an open clause of either payer with an amount between 1 and MAX_AMOUNT
  pure val LOCKOPTS: Set[a::Lock] =
    Set(a::NO_LOCK)
      .union(1.to(a::MAX_AMOUNT).map(m => { on: true, payer: a::Left, amount: m, hashlock: 11, deadline: 3 }))
      .union(1.to(a::MAX_AMOUNT).map(m => { on: true, payer: a::Right, amount: m, hashlock: 12, deadline: 3 }))

  // Bodies are not built as a set (that is thousands of records): the quantifiers below walk the domain one body at a time.
  pure def mk(o: int, ll: int, lr: int, l1: a::Lock, l2: a::Lock): a::Body =
    { offdelta: o, limitLeft: ll, limitRight: lr, locks: Map(1 -> l1, 2 -> l2) }

  pure def forallBodies(p: a::Body => bool): bool =
    OFFS.forall(o => LIMS.forall(ll => LIMS.forall(lr => LOCKOPTS.forall(l1 => LOCKOPTS.forall(l2 => p(mk(o, ll, lr, l1, l2)))))))

  pure def existsBody(p: a::Body => bool): bool =
    OFFS.exists(o => LIMS.exists(ll => LIMS.exists(lr => LOCKOPTS.exists(l1 => LOCKOPTS.exists(l2 => p(mk(o, ll, lr, l1, l2)))))))

  // what a resolved clause does to Left's allocation: a Left payer makes it smaller, a Right payer larger
  pure def effect(l: a::Lock, resolved: bool): int =
    if (l.on and resolved) (match l.payer { | Left => -l.amount | Right => l.amount }) else 0

  pure def settledDelta(b: a::Body, r1: bool, r2: bool): int =
    b.offdelta + effect(b.locks.get(1), r1) + effect(b.locks.get(2), r2)

  // the chain settles Δ over the collateral with empty reserves: every shortfall becomes debt
  pure val EMPTY: c::Money = { res: Map(c::Left -> 0, c::Right -> 0), debt: Map(c::Left -> 0, c::Right -> 0), dq: Map(c::Left -> [], c::Right -> []), out: 0 }
  pure def settle(d: int): c::Money = c::payout(EMPTY, a::COLLATERAL, d)

  pure val OUTCOMES: Set[(bool, bool)] = Set((false, false), (false, true), (true, false), (true, true))

  // P2 on the chain side: no outcome leaves a side owing more than the credit its counterparty granted, and the collateral is
  // paid out in full (P3): nothing is created, nothing is lost.
  pure def honoured(b: a::Body, o: (bool, bool)): bool = {
    val m = settle(settledDelta(b, o._1, o._2))
    and {
      m.debt.get(c::Left) <= b.limitLeft,
      m.debt.get(c::Right) <= b.limitRight,
      m.res.get(c::Left) >= 0, m.res.get(c::Right) >= 0,
      m.res.get(c::Left) + m.res.get(c::Right) == a::COLLATERAL,
      m.debt.get(c::Left) == 0 or m.debt.get(c::Right) == 0
    }
  }

  pure val CREDIT_HOLDS_ON_CHAIN: bool =
    forallBodies(b => not(a::rcpan(b)) or OUTCOMES.forall(o => honoured(b, o)))

  // the domain has bodies with two open clauses and with real debt, so the check is not vacuous
  pure val COVERS_TWO_CLAUSES: bool = existsBody(b => a::rcpan(b) and a::lockCount(b) == 2)
  pure val COVERS_DEBT: bool = existsBody(b => a::rcpan(b) and OUTCOMES.exists(o => settle(settledDelta(b, o._1, o._2)).debt.get(c::Left) > 0))

  run accountCreditHoldsOnTheChainTest = c::init.expect(and { COVERS_TWO_CLAUSES, COVERS_DEBT, CREDIT_HOLDS_ON_CHAIN })

  // the same check with a weaker predicate (RCPAN without the open clauses) is violated: what the clauses add to the sum matters
  pure def weakRcpan(b: a::Body): bool = and { a::delta(b) >= -b.limitLeft, a::delta(b) <= a::COLLATERAL + b.limitRight }
  pure val WEAK_IS_NOT_ENOUGH: bool = existsBody(b => weakRcpan(b) and OUTCOMES.exists(o => not(honoured(b, o))))

  run clausesMatterToTheChainTest = c::init.expect(WEAK_IS_NOT_ENOUGH)

  // one clause is enough to show the sum is what the contract computes: settling the clauses one by one and adding is the same as
  // adding first (each clause adds its amount to the delta independently, DeltaTransformer.applyPayment)
  pure val ADDITIVE: bool = forallBodies(b => OUTCOMES.forall(o =>
    settledDelta(b, o._1, o._2) == b.offdelta + effect(b.locks.get(1), o._1) + effect(b.locks.get(2), o._2)))

  run clausesAreAdditiveTest = c::init.expect(ADDITIVE)
  // R-SETTLE-CREDIT (coordinator 09-30, Q-X-3). A cooperative settlement withdraws collateral for one side. The approver's rule is
  // `settlementOk`; this checks it against the chain: for every Body that holds RCPAN and every withdrawal it would co-sign, every outcome
  // of the open clauses settles over the smaller collateral with no side owing more than the credit its counterparty granted. The test rig
  // found the missing refusal (a co-signed settlement left Left at delta -7,000,031 against credit 18,092).
  pure def settleAt(coll: int, d: int): c::Money = c::payout(EMPTY, coll, d)
  pure def honouredAfter(b: a::Body, by: a::Side, w: int, o: (bool, bool)): bool = {
    val coll = a::COLLATERAL - w
    val d = settledDelta(b, o._1, o._2) - (if (by == a::Left) w else 0)
    val m = settleAt(coll, d)
    and {
      m.debt.get(c::Left) <= b.limitLeft,
      m.debt.get(c::Right) <= b.limitRight,
      m.res.get(c::Left) + m.res.get(c::Right) == coll
    }
  }
  pure val SIDES2: Set[a::Side] = Set(a::Left, a::Right)
  pure val WITHDRAWALS: Set[int] = 1.to(a::COLLATERAL)
  pure val SETTLEMENT_KEEPS_CREDIT: bool =
    forallBodies(b => not(a::rcpan(b)) or SIDES2.forall(by => WITHDRAWALS.forall(w =>
      not(a::settlementOk(b, by, w)) or OUTCOMES.forall(o => honouredAfter(b, by, w, o)))))
  // the domain has both answers: a withdrawal inside the claim is co-signed, one beyond it is refused
  pure val COVERS_BOTH_ANSWERS: bool =
    existsBody(b => a::rcpan(b) and SIDES2.exists(by => WITHDRAWALS.exists(w => a::settlementOk(b, by, w)))) and
    existsBody(b => a::rcpan(b) and SIDES2.exists(by => WITHDRAWALS.exists(w => not(a::settlementOk(b, by, w)))))

  run settlementKeepsCreditTest = c::init.expect(and { COVERS_BOTH_ANSWERS, SETTLEMENT_KEEPS_CREDIT })

  // the approver never co-signs a withdrawal of more than the collateral, whatever the credit (the bound `w <= COLLATERAL` of `settlementOk`)
  pure val NO_WITHDRAWAL_BEYOND_COLLATERAL: bool =
    forallBodies(b => not(a::rcpan(b)) or SIDES2.forall(by => not(a::settlementOk(b, by, a::COLLATERAL + 1))))
  run noWithdrawalBeyondTheCollateralTest = c::init.expect(NO_WITHDRAWAL_BEYOND_COLLATERAL)

  // R-SIGNED-IS-LIVE (coordinator 10-01): what a refusal leaves behind. A hub (Left) proposed a frame that locks 1 towards the next hop (Right), the next hop refused it, and the
  // hub released the payer's hold and the one above it. But the hub signed that frame's proof when it proposed it (A5) and the next hop holds it: a dispute start needs a
  // proof signed by the OTHER party and nothing else (`canStart`), and the proof sits at a higher nonce than the committed tip, so the hub has nothing above it to answer with.
  // The chain settles it, and the lock pays the next hop once it knows the secret: the hub owes 1 that no upstream payer covers. The bodies come from the Account layer
  // (`applyTx` builds the locked state), the settlement from the chain's own game.
  pure def chainSide(s: a::Side): c::Side = match s { | Left => c::Left | Right => c::Right }
  pure def chainProof(b: a::Body, nonce: int, la: bool, sl: bool, sr: bool): c::SignedProof = {
    val l = b.locks.get(1)
    val clause: c::Clause = if (l.on) { on: true, payer: chainSide(l.payer), amount: l.amount, deadline: l.deadline } else c::NO_CLAUSE
    c::mkProof(true, nonce, 0, la, b.offdelta, clause, sl, sr)
  }
  pure val TIP: a::Body = { ...a::GENESIS, limitLeft: 2 }                          // the committed state at nonce 1 (Right granted Left credit)
  pure val LOCK: a::Tx = a::HtlcLock({ id: 1, payer: a::Left, amount: 1, hashlock: a::hashOf(1), deadline: 4 })
  pure val LOCKED: a::Body = match a::applyTx(TIP, LOCK, a::Left, 1) { | Ok(b) => b | Refused(_) => TIP }
  pure val TIP_PROOF = chainProof(TIP, 1, false, true, true)                       // both signed, Right-authored
  pure val STALE_PROOF = chainProof(LOCKED, 2, true, true, false)                  // the refused frame (2, Left): signed by its author only, held by the next hop
  pure val HUB_ARENA: int -> c::SignedProof = c::SLOTS.mapBy(_ => c::NO_PROOF).set(1, TIP_PROOF).set(4, STALE_PROOF)

  run refusedProofWithTheLockIsEnforcedOnTheChainTest =
    c::initFrom(HUB_ARENA, c::Left, 0, 0, a::COLLATERAL)
    .expect(and { STALE_PROOF.clause.on, c::rank(STALE_PROOF) > c::rank(TIP_PROOF), c::signedBy(STALE_PROOF, c::Left), not(c::signedBy(STALE_PROOF, c::Right)) })
    .then(c::learn(c::Right))                                                      // the next hop learned the secret downstream
    .then(c::startWith(c::Right, 4, true, 0, false))                              // it starts with the proof the hub signed, revealing the secret in the start
    .then(c::finalizeWith(c::Left, 0, 0, false))                                  // nothing above it exists to counter with: the hub, the non-starter, closes at once
    .expect(and { c::money.debt.get(c::Left) == 1, c::money.debt.get(c::Right) == 0, c::acct.nonce == 3, c::safe })

  // The same history with one frame above the stale proof (a both-signed state at nonce 3, the one a superseding commit makes): the hub's counter outranks the stale proof and the
  // lock is gone. This is what "superseded" buys: the release of the hold is safe from then on.
  pure val ABOVE_PROOF = chainProof(TIP, 3, false, true, true)
  run supersededProofIsCounteredOnTheChainTest =
    c::initFrom(HUB_ARENA.set(5, ABOVE_PROOF), c::Left, 0, 0, a::COLLATERAL)
    .then(c::learn(c::Right))
    .then(c::startWith(c::Right, 4, true, 0, false))
    .then(c::honestCounter)
    .then(c::tick).then(c::tick).then(c::tick).then(c::tick)
    .then(c::honestFinalize)
    .expect(and { c::money.debt.get(c::Left) == 0, c::money.debt.get(c::Right) == 0, c::money.res == Map(c::Left -> 0, c::Right -> 2), c::acct.nonce == 3, c::safe })

  // R-PROOF-NONCE-ABOVE-SIGNED (coordinator 10-01), the chain side of Review A's schedule (b). Left signed a proof (nonce 2, Left-authored) that Right refused; Right then
  // commits a payment of 1 to Left. If the committed frame is at the nonce of the stale proof (the nonce taken from the committed tip) the chain ranks the Left-authored proof
  // above it (nonce * 2 + leftAuthored): Right, holding Left's signature, starts with it, Left has nothing above it to counter with, and the payment is erased (Left gets 0, not 1).
  // With the committed frame above the signed nonce (3: what the Account layer now signs) Left's counter outranks the stale proof and the payment stands.
  pure val PAID: a::Body = { ...TIP, offdelta: 1 }                                  // Right paid Left 1
  pure val STALE_AT_2 = chainProof(TIP, 2, true, true, false)                       // Left's refused attempt: signed by Left, held by Right
  pure def paymentCase(committedNonce: int): int -> c::SignedProof =
    c::SLOTS.mapBy(_ => c::NO_PROOF).set(1, TIP_PROOF).set(2, chainProof(PAID, committedNonce, false, true, true)).set(4, STALE_AT_2)

  run staleProofAtTheCommittedNonceErasesThePaymentTest =
    c::initFrom(paymentCase(2), c::Left, 0, 0, a::COLLATERAL)
    .expect(c::rank(STALE_AT_2) > c::rank(paymentCase(2).get(2)))
    .then(c::startWith(c::Right, 4, false, 0, false))
    .expect(c::honestCounterId(c::arena, c::acct, c::dispute, c::Left) == 0)       // Left holds a newer both-signed proof, but it does not outrank the stale one
    .then(c::tick).then(c::tick).then(c::tick).then(c::tick)
    .then(c::finalizeWith(c::Right, 0, 0, false))
    .expect(and { c::money.res == Map(c::Left -> 0, c::Right -> 2), c::acct.nonce == 3 })

  run staleProofBelowTheCommittedNonceIsCounteredTest =
    c::initFrom(paymentCase(3), c::Left, 0, 0, a::COLLATERAL)
    .expect(c::rank(STALE_AT_2) < c::rank(paymentCase(3).get(2)))
    .then(c::startWith(c::Right, 4, false, 0, false))
    .then(c::honestCounter)
    .then(c::tick).then(c::tick).then(c::tick).then(c::tick)
    .then(c::honestFinalize)
    .expect(and { c::money.res == Map(c::Left -> 1, c::Right -> 1), c::acct.nonce == 3, c::safe })
}
