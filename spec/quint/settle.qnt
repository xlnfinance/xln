// XLN settlement and epochs: how an Account crosses an epoch boundary without losing a payment or hostage-taking a party.
//
// The chain (chain.qnt) advances the ondelta epoch on every event that moves custody: a cooperative update, a finalize.
// Every proof binds the epoch (C1), so a boundary kills all older proofs. This module is the off-chain side of that
// rule: the Account state machine that stops signing for a dying epoch (N1) and gets the next epoch started.
//
// R-IMPLICIT-BASELINE (plan/contracts-decisions.md, replaces the co-signed baselines of the old N1): the new epoch needs no ceremony. From
// epoch 1 on the chain itself offers a proof to dispute with, the implicit proof (empty state, nonce stored + 1, authored by Right, no
// signature; chain.qnt `implicitProof`), settling at Delta = ondelta. A cooperative update therefore folds the offdelta into the ondelta (what
// both sides agreed is then exactly what the implicit proof pays), and a finalize pays everything out. The Runtime rule that goes with it:
// the first signed proof of a new epoch takes nonce >= stored + 2, with the stored nonce READ from the chain (a timeout finalize leaves
// initial + 1, a counter or a signed branch the proof's own nonce, an update its own); the epoch's own counter is gapless after that.
// Why +2: a Right-authored proof at stored + 1 only TIES the implicit proof, a tie is a refused counter, and the starter of the implicit dispute
// would settle at ondelta and lose the frame (the trap, chain_test `theTrapLosesTheFramesValueTest`).
//
// Scope, stated as a proposal where the sources are silent (each point is in QUESTIONS.md, section S):
//   - The frame protocol is abstracted to propose (author signs one proof) and ack (the other signs it): collisions,
//     loss and resend are account.qnt's job. The proof nonce is its own counter, decoupled from frame height.
//   - The Account offdelta changes only by payments. A cooperative update ("Lock" frame, then the update itself) moves
//     custody: a diff (dl, dr) of the two reserves, the collateral moves by -(dl+dr), and ondelta by -dl plus the
//     folded offdelta.
//   - Each side sees the chain with a lag: `seen` is what it last observed; the honest side observes before time
//     passes (that is the lag bound: it must be shorter than the response window, see QUESTIONS S6).
//   - Single token (multi-token Accounts, where the starter of an implicit dispute names the tokens, are v2: V2.md).
//
// Properties (all in `wsafe`):
//   no_dead_commit    no payment is committed in an epoch the chain already left
//   no_lost_pay       an update never executes over a state that has changed since it was signed
//   claims_conserved  an update moves custody without changing what either side would be paid if the Account closed
//   book_enforceable  the honest side's newest proof of the chain's epoch pays exactly what both agreed
//   hostage_free      the honest side can always close the Account, whatever the other side does (a signed proof, or the implicit one)
//   first_proof_at_stored_plus_two  the honest side never signs the first proof of an epoch below stored + 2
module settle {
  import chain.* from "./chain"

  pure val OFFMAX = 3
  pure val NUPD = 5
  pure val FIRST_GAP = 2        // the first signed proof of an epoch is at stored + 2 or above (R-IMPLICIT-BASELINE: a Right-authored one at stored + 1 only ties the implicit proof)

  type Kind = | KPay({ from: Side, amt: int }) | KLock({ dl: int, dr: int })
  type Prop = { on: bool, author: Side, pid: int, kind: Kind }
  type View = { epoch: int, nonce: int, dispute: bool }
  // A cooperative update: signed by the side that does not submit it. `fold` is the offdelta it folds into ondelta.
  type Upd = { live: bool, epoch: int, nonce: int, dl: int, dr: int, fold: int, sigL: bool, sigR: bool }
  // tip: newest both-signed proof the Account has (it may be of an epoch the chain has left: the new epoch's first frame replaces it);
  // locked: the pending update (0 = the Account is open for payments)
  type Acc = { tip: int, locked: int }
  type WG = { deadCommit: bool, lostPay: bool, claimBroken: bool, firstLow: bool, execs: int, commits: int }

  var seen: Side -> View
  var acc: Acc
  var book: int                 // the offdelta both sides agreed, across all commits (ghost)
  var prop: Prop
  var np: int                   // next free arena slot
  var upds: int -> Upd
  var nu: int
  var wg: WG

  pure val NO_UPD: Upd = { live: false, epoch: 0, nonce: 0, dl: 0, dr: 0, fold: 0, sigL: false, sigR: false }
  pure val NO_PROP: Prop = { on: false, author: Left, pid: 0, kind: KLock({ dl: 0, dr: 0 }) }

  pure def absI(x: int): int = if (x < 0) -x else x
  pure def payDelta(from: Side, amt: int): int = match from { | Left => -amt | Right => amt }
  pure def viewOf(a: Acct, d: Dispute): View = { epoch: a.epoch, nonce: a.nonce, dispute: d.on }
  pure def signedByU(u: Upd, s: Side): bool = match s { | Left => u.sigL | Right => u.sigR }
  // the payee of a payment frame is the side it does not come from; only a payee holding a dead proof loses anything
  pure def paidToHonest(k: Kind, hon: Side): bool = match k { | KPay(x) => x.from != hon | _ => false }
  pure def isPay(k: Kind): bool = match k { | KPay(_) => true | _ => false }
  pure def isLock(k: Kind): bool = match k { | KLock(_) => true | _ => false }

  // The proof a proposal carries, built from the author's own knowledge of the tip and the chain. The first proof of an epoch the author
  // has read past its tip (tp is of an older epoch) takes the chain's stored nonce + FIRST_GAP and starts the offdelta from 0 (an update folded
  // it into the ondelta, a finalize paid everything out); every later one follows the tip by one.
  pure def isFirst(tp: SignedProof, sv: View): bool = tp.epoch < sv.epoch
  pure def proofFor(k: Kind, author: Side, tp: SignedProof, sv: View): SignedProof = {
    val la = isLeft(author)
    val first = isFirst(tp, sv)
    val n = if (first) sv.nonce + FIRST_GAP else tp.nonce + 1
    val e = if (first) sv.epoch else tp.epoch
    val base = if (first) 0 else tp.offdelta
    match k {
      | KPay(x) => mkProof(true, n, e, la, base + payDelta(x.from, x.amt), NO_CLAUSE, la, not(la))
      | KLock(_) => mkProof(true, n, e, la, base, NO_CLAUSE, la, not(la))
    }
  }

  // The first proof of an epoch signed below stored + 2, while the chain is in that epoch and no dispute runs (so its stored nonce is the one the
  // epoch opened at): the ghost the Runtime's rule is judged by.
  pure def lowFirst(p: SignedProof, tp: SignedProof, a: Acct, d: Dispute): bool =
    p.epoch > tp.epoch and p.epoch == a.epoch and not(d.on) and p.nonce < a.nonce + FIRST_GAP

  // What the chain would pay each side if the Account closed on this state: the yardstick for "custody moved, claims did not".
  pure def closesTo(m: Money, coll: int, ondelta: int, off: int): Money = payout(m, coll, ondelta + off)

  // ---------------------------------------------------------------------------------------------------------
  // The rule of the Account state machine (N1). A side runs it before it signs (as author) and before it acks.
  //   Pay, Lock  the Account is open, both the side and the proof are in the same epoch; the proof nonce follows the tip, or, for the first
  //              proof of an epoch (the tip is of an older epoch), it is at least the stored nonce the side read + FIRST_GAP, and its
  //              offdelta starts from the agreed book (0: the epoch event folded or paid out everything)
  // ---------------------------------------------------------------------------------------------------------
  pure def rulesOk(sv: View, a: Acc, tp: SignedProof, bk: int, p: SignedProof, k: Kind, m: Money, coll: int): bool = and {
    not(sv.dispute),                           // a side that has started or answered a dispute knows it at once (cHonestDisputes)
    a.locked == 0, sv.epoch == p.epoch,
    if (p.epoch == tp.epoch) p.nonce == tp.nonce + 1
    else and { p.epoch > tp.epoch, p.nonce >= sv.nonce + FIRST_GAP, p.offdelta == bk + (match k { | KPay(x) => payDelta(x.from, x.amt) | KLock(_) => 0 }) },
    match k {
      | KPay(x) => absI(p.offdelta) <= OFFMAX
      | KLock(l) => and {
          m.res.get(Left) + l.dl >= 0, m.res.get(Right) + l.dr >= 0, coll - (l.dl + l.dr) >= 0,
          l.dl != 0 or l.dr != 0
        }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------------------------------------

  action winit: bool = {
    nondet hon = SIDES.oneOf()
    nondet resL = 0.to(2).oneOf()
    nondet resR = 0.to(2).oneOf()
    nondet cl = 0.to(2).oneOf()
    nondet cr = 0.to(2).oneOf()
    sinit(hon, resL, resR, cl, cr)
  }

  // Both sides hold a both-signed proof at nonce 1 of epoch 0; `cl` / `cr` is what each side has put into collateral.
  action sinit(hon: Side, resL: int, resR: int, cl: int, cr: int): bool = {
    val base = mkProof(true, 1, 0, true, 0, NO_CLAUSE, true, true)
    all {
      arena' = SLOTS.mapBy(i => if (i == 1) base else NO_PROOF),
      honest' = hon,
      now' = 1,
      acct' = { nonce: 0, epoch: 0, coll: cl + cr, ondelta: cl, via: 0 },
      money' = { res: Map(Left -> resL, Right -> resR), debt: Map(Left -> 0, Right -> 0), dq: Map(Left -> [], Right -> []), out: 0 },
      total' = resL + resR + cl + cr,
      dispute' = NO_DISPUTE,
      registry' = 0,
      knows' = Map(Left -> 0, Right -> 0),
      offline' = false,
      applied' = SLOTS.mapBy(_ => false),
      ghost' = NO_GHOST,
      seen' = SIDES.mapBy(_ => { epoch: 0, nonce: 0, dispute: false }),
      acc' = { tip: 1, locked: 0 },
      book' = 0,
      prop' = NO_PROP,
      np' = 2,
      upds' = 0.to(NUPD - 1).mapBy(_ => NO_UPD),
      nu' = 1,
      wg' = { deadCommit: false, lostPay: false, claimBroken: false, firstLow: false, execs: 0, commits: 0 }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Frames that leave the chain alone
  // ---------------------------------------------------------------------------------------------------------

  action keepChain: bool = all {
    honest' = honest, now' = now, acct' = acct, money' = money, total' = total, dispute' = dispute, registry' = registry,
    knows' = knows, offline' = offline, applied' = applied, ghost' = ghost
  }

  // author signs one proof and offers it; the other side has not answered
  action offPropose(author: Side, k: Kind): bool = offProposeAdj(author, k, 0)

  // The same, with the nonce of the proof lowered by `adj` (an adversary that offers the first proof of an epoch at stored + 1, or a repeat of the tip's
  // nonce). The honest side follows its rule and never lowers it.
  action offProposeAdj(author: Side, k: Kind, adj: int): bool = offProposeX(author, k, adj, 0)

  // ... and with the offdelta of the proof moved by `dOff` (a forged first frame that does not continue from what both agreed).
  action offProposeX(author: Side, k: Kind, adj: int, dOff: int): bool = {
    val tp = arena.get(acc.tip)
    val sv = seen.get(author)
    val p0 = proofFor(k, author, tp, sv)
    val p = { ...p0, nonce: p0.nonce - adj, offdelta: p0.offdelta + dOff }
    all {
      (author == honest) implies dOff == 0,
      adj >= 0, (author == honest) implies adj == 0,
      not(prop.on), np < NREC, nu < NUPD,
      match k { | KPay(x) => x.from == author | _ => true },
      (author == honest) implies rulesOk(sv, acc, tp, book, p, k, money, acct.coll),
      arena' = arena.set(np, p),
      prop' = { on: true, author: author, pid: np, kind: k },
      np' = np + 1,
      keepChain,
      seen' = seen, acc' = acc, book' = book, upds' = upds, nu' = nu,
      wg' = { ...wg, firstLow: wg.firstLow or (author == honest and lowFirst(p, tp, acct, dispute)) }
    }
  }

  // an offer nobody answers: it lapses, its signature stays in the world (the counterparty may use it in a dispute)
  action abandon: bool = all {
    prop.on, prop' = NO_PROP,
    keepChain,
    arena' = arena, seen' = seen, acc' = acc, book' = book, np' = np, upds' = upds, nu' = nu, wg' = wg
  }

  // Whoever is honest applies the rules again when the answer arrives: as the acker to what it is asked to sign, as the
  // author to a proposal whose world may have moved since it signed (the ack of a stale offer is dropped, not committed).
  pure def ackable(prop: Prop, seenBy: Side -> View, a: Acc, tp: SignedProof, bk: int, p: SignedProof, m: Money, coll: int, hon: Side): bool =
    rulesOk(seenBy.get(hon), a, tp, bk, p, prop.kind, m, coll)

  action ackPay: bool = {
    val p = arena.get(prop.pid)
    val acker = other(prop.author)
    all {
      prop.on, isPay(prop.kind),
      ackable(prop, seen, acc, arena.get(acc.tip), book, p, money, acct.coll, honest),
      arena' = arena.set(prop.pid, { ...p, sigL: true, sigR: true }),
      acc' = { ...acc, tip: prop.pid },
      book' = p.offdelta,
      prop' = NO_PROP,
      wg' = { ...wg, deadCommit: wg.deadCommit or (p.epoch != acct.epoch and paidToHonest(prop.kind, honest)), commits: wg.commits + 1,
              firstLow: wg.firstLow or (acker == honest and lowFirst(p, arena.get(acc.tip), acct, dispute)) },
      np' = np,
      keepChain,
      seen' = seen, upds' = upds, nu' = nu
    }
  }

  // A Lock commits the update the two sides intend to execute. From here payments pause.
  action ackLock: bool = {
    val p = arena.get(prop.pid)
    val acker = other(prop.author)
    val lk = match prop.kind { | KLock(l) => l | _ => { dl: 0, dr: 0 } }
    val u: Upd = { live: true, epoch: p.epoch, nonce: p.nonce + 1, dl: lk.dl, dr: lk.dr, fold: p.offdelta,
                   sigL: false, sigR: false }
    all {
      prop.on, isLock(prop.kind),
      ackable(prop, seen, acc, arena.get(acc.tip), book, p, money, acct.coll, honest),
      arena' = arena.set(prop.pid, { ...p, sigL: true, sigR: true }),
      np' = np,
      acc' = { tip: prop.pid, locked: nu },
      upds' = upds.set(nu, u),
      nu' = nu + 1,
      prop' = NO_PROP,
      wg' = { ...wg, commits: wg.commits + 1, firstLow: wg.firstLow or (acker == honest and lowFirst(p, arena.get(acc.tip), acct, dispute)) },
      keepChain,
      seen' = seen, book' = book
    }
  }

  // A side reads the chain. Once the epoch it reads is past the tip's, a pending lock is dead (the update executed, or a finalize killed it) and
  // payments may resume: the next proof is the first of the new epoch.
  action observe(s: Side): bool = all {
    seen.get(s) != viewOf(acct, dispute),
    seen' = seen.set(s, viewOf(acct, dispute)),
    acc' = if (acct.epoch > arena.get(acc.tip).epoch) { ...acc, locked: 0 } else acc,
    keepChain,
    arena' = arena, book' = book, prop' = prop, np' = np, upds' = upds, nu' = nu, wg' = wg
  }

  // ---------------------------------------------------------------------------------------------------------
  // The cooperative update
  // ---------------------------------------------------------------------------------------------------------

  // The honest side signs only the update it has locked, and not while it has seen a dispute.
  action signUpd(s: Side, uid: int): bool = {
    val u = upds.get(uid)
    all {
      uid >= 1, uid < NUPD, u.live,
      (s == honest) implies (acc.locked == uid and not(seen.get(s).dispute)),
      upds' = upds.set(uid, match s { | Left => { ...u, sigL: true } | Right => { ...u, sigR: true } }),
      keepChain,
      arena' = arena, seen' = seen, acc' = acc, book' = book, prop' = prop, np' = np, nu' = nu, wg' = wg
    }
  }

  // Depository processSettlements: submitted by `x`, signed by the other side. The epoch, the nonce, custody and the
  // absence of a dispute are the contract's guards. A cooperative update moves nonce to its own value and opens epoch+1.
  action execUpd(x: Side, uid: int): bool = {
    val u = upds.get(uid)
    val dColl = -(u.dl + u.dr)
    val dOn = -u.dl + u.fold                            // the offdelta both agreed is folded into the ondelta: the implicit proof of the new epoch pays exactly that
    val m2: Money = { res: money.res.set(Left, money.res.get(Left) + u.dl).set(Right, money.res.get(Right) + u.dr), debt: money.debt, dq: money.dq, out: money.out }
    val offAfter = 0
    val a2: Acct = { nonce: u.nonce, epoch: acct.epoch + 1, coll: acct.coll + dColl, ondelta: acct.ondelta + dOn, via: uid }
    all {
      uid >= 1, uid < NUPD, u.live,
      signedByU(u, other(x)),
      not(dispute.on),
      u.epoch == acct.epoch,                          // C1: an update signed for another epoch is dead
      u.nonce > acct.nonce,
      acct.coll + dColl >= 0,
      money.res.get(Left) + u.dl >= 0, money.res.get(Right) + u.dr >= 0,
      acct' = a2,
      money' = m2,
      book' = offAfter,
      wg' = { ...wg,
              lostPay: wg.lostPay or book != u.fold,
              claimBroken: wg.claimBroken or closesTo(m2, a2.coll, a2.ondelta, offAfter) != closesTo(money, acct.coll, acct.ondelta, u.fold),
              execs: wg.execs + 1 },
      arena' = arena, honest' = honest, now' = now, total' = total, dispute' = dispute, registry' = registry,
      knows' = knows, offline' = offline, applied' = applied, ghost' = ghost,
      seen' = seen, acc' = acc, prop' = prop, np' = np, upds' = upds, nu' = nu
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // The chain's own actions, with the honest side reading the chain first
  // ---------------------------------------------------------------------------------------------------------

  // the honest side can start a dispute: it holds a signed proof of the chain's epoch to start with, or (from epoch 1) the implicit proof is there
  val startable: bool = canStartAny({ ar: arena, a: acct, d: dispute }, honest)

  // the honest side is up to date on what matters for signing: the epoch and whether a dispute runs (the nonce it reads on observe)
  val fresh: bool = seen.get(honest).epoch == acct.epoch and seen.get(honest).dispute == dispute.on

  action keepSettle: bool = all {
    seen' = seen, acc' = acc, book' = book, prop' = prop, np' = np, upds' = upds, nu' = nu, wg' = wg
  }

  action cNeutral(a: bool): bool = all { a, keepSettle }
  action cHonest(a: bool): bool = all { fresh, a, keepSettle }
  // the honest side that starts or answers a dispute knows it from that moment: it stops signing before it has read the block
  action cHonestDisputes(a: bool): bool = all {
    fresh, a,
    seen' = seen.set(honest, { ...seen.get(honest), dispute: true }),
    acc' = acc, book' = book, prop' = prop, np' = np, upds' = upds, nu' = nu, wg' = wg
  }
  // a finalize pays everything out: the new epoch starts from nothing
  action cFinalize(a: bool): bool = all {
    a,
    book' = 0,
    seen' = seen, acc' = acc, prop' = prop, np' = np, upds' = upds, nu' = nu, wg' = wg
  }

  action wstep = any {
    cHonest(tick),                        // time passes only when the honest side has read the chain (the lag bound)
    cNeutral(learn(Left)), cNeutral(learn(Right)),
    cNeutral(publish(Left)), cNeutral(publish(Right)),
    cNeutral(setOffline(true)), cNeutral(setOffline(false)),
    // a side funds its own share; the honest side does so only into an Account it holds a proof for (S: fund after open)
    { nondet a = 1.to(2).oneOf() nondet who = SIDES.oneOf() cNeutral(all { who != honest or startable, r2c(who, who, a) }) },
    cNeutral(adversaryStart), cNeutral(adversaryStartImplicit), cHonestDisputes(honestStart),
    cNeutral(adversaryCounter), cHonestDisputes(honestCounter),
    cFinalize(adversaryFinalize), cFinalize(all { fresh, honestFinalize }),
    { nondet who = SIDES.oneOf() nondet a = 1.to(2).oneOf() nondet adj = 0.to(1).oneOf() offProposeAdj(who, KPay({ from: who, amt: a }), adj) },
    { nondet who = SIDES.oneOf() nondet l = (-1).to(1).oneOf() nondet r = (-1).to(1).oneOf() nondet adj = 0.to(1).oneOf() offProposeAdj(who, KLock({ dl: l, dr: r }), adj) },
    ackPay, ackLock, abandon,
    observe(Left), observe(Right),
    { nondet who = SIDES.oneOf() nondet uid = 1.to(NUPD - 1).oneOf() signUpd(who, uid) },
    { nondet who = SIDES.oneOf() nondet uid = 1.to(NUPD - 1).oneOf() all { who != honest or fresh, execUpd(who, uid) } }
  }

  // The settlement lifecycle alone, without the chain's dispute noise: random search reaches deep schedules (pay, lock,
  // sign, execute, read, first frame of the new epoch) far more often. Used to hunt mutants; the full `wstep` is the one that must stay green.
  action wfocus = any {
    { nondet who = SIDES.oneOf() nondet a = 1.to(2).oneOf() nondet adj = 0.to(1).oneOf() offProposeAdj(who, KPay({ from: who, amt: a }), adj) },
    { nondet who = SIDES.oneOf() nondet l = (-1).to(1).oneOf() nondet r = (-1).to(1).oneOf() nondet adj = 0.to(1).oneOf() offProposeAdj(who, KLock({ dl: l, dr: r }), adj) },
    ackPay, ackLock,
    observe(Left), observe(Right),
    { nondet who = SIDES.oneOf() signUpd(who, 1) },
    { nondet who = SIDES.oneOf() execUpd(who, 1) },
    cNeutral(setOffline(false))
  }

  // ---------------------------------------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------------------------------------

  val no_dead_commit: bool = not(wg.deadCommit)
  val no_lost_pay: bool = not(wg.lostPay)
  val claims_conserved: bool = not(wg.claimBroken)

  // the honest side's newest both-signed proof of the chain's epoch pays what both agreed
  val book_enforceable: bool = {
    val t = tipId(arena, acct.epoch)
    t == 0 or arena.get(t).offdelta == book
  }

  // R-IMPLICIT-BASELINE, the Runtime's rule: the first signed proof of an epoch takes nonce >= stored + 2 (stored read from the chain). The
  // honest side never signs one lower (as author or as acker), whatever the other side offers: a Right-authored proof at stored + 1 only ties the
  // implicit proof, and the starter of the implicit dispute would settle at the ondelta and lose the frame.
  val first_proof_at_stored_plus_two: bool = not(wg.firstLow)

  // what the honest side would hold in the Account if it closed on the agreed offdelta (debt ignored)
  val honestStake: int = {
    val d = imax(0, imin(acct.coll, acct.ondelta + book))
    if (isLeft(honest)) d else acct.coll - d
  }

  // the honest side can start a dispute now, or one is already running, or nothing is at stake
  val exit_ok: bool = or {
    honestStake == 0,
    dispute.on,
    startable
  }
  val hostage_free: bool = exit_ok

  val wsafe: bool = and { safe, no_dead_commit, no_lost_pay, claims_conserved, book_enforceable, hostage_free, first_proof_at_stored_plus_two }

  // coverage: each must be violated by some run
  val w_no_lock: bool = acc.locked == 0
  val w_no_update: bool = wg.execs == 0
  val w_no_second_epoch: bool = acct.epoch < 2
  val w_no_payment: bool = book == 0
  // a frame of the new epoch is signed after an update: the first proof of the epoch exists
  val w_no_first_frame_of_the_epoch: bool = not(wg.execs > 0 and acct.epoch > 0 and arena.get(acc.tip).epoch == acct.epoch)
  // the first frame of a new epoch is offered by the other side below stored + 2 and the honest side refuses it: the rule bites
  val w_no_refused_low_first_frame: bool = not(prop.on and acct.epoch > 0 and arena.get(prop.pid).epoch == acct.epoch and arena.get(acc.tip).epoch < acct.epoch and arena.get(prop.pid).nonce < acct.nonce + FIRST_GAP and prop.author != honest)
}
