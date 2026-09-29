// XLN settlement and epochs: how an Account crosses an epoch boundary without losing a payment or hostage-taking a party.
//
// The chain (chain.qnt) advances the ondelta epoch on every event that moves custody: a cooperative update, a finalize.
// Every proof binds the epoch (C1), so a boundary kills all older proofs. This module is the off-chain side of that
// rule: the Account state machine that stops signing for a dying epoch (N1) and gets the next epoch started.
//
// Scope, stated as a proposal where the sources are silent (each point is in QUESTIONS.md, section S):
//   - The frame protocol is abstracted to propose (author signs one proof) and ack (the other signs it): collisions,
//     loss and resend are account.qnt's job. The proof nonce is its own counter, decoupled from frame height.
//   - The Account offdelta changes only by payments. A cooperative update ("Lock" frame, then the update itself) moves
//     custody: a diff (dl, dr) of the two reserves, the collateral moves by -(dl+dr), and ondelta by -dl (plus the
//     folded offdelta in fold mode).
//   - Two ways to open the next epoch, chosen at init (`presign`):
//       presign = false  N1 as decided: after the epoch event is observed, both sides co-sign a baseline proof (Rebase
//                        frame). Until then the Account has no proof for the epoch.
//       presign = true   the Lock frame also co-signs the baseline of epoch+1, and the update folds offdelta into
//                        ondelta, so that baseline is always "offdelta 0, no clauses": correct whichever event opens
//                        the epoch (an update or a finalize, which pays everything out).
//   - Each side sees the chain with a lag: `seen` is what it last observed; the honest side observes before time
//     passes (that is the lag bound: it must be shorter than the response window, see QUESTIONS S6).
//
// Properties (all in `wsafe`):
//   no_dead_commit    no payment is committed in an epoch the chain already left
//   no_lost_pay       an update never executes over a state that has changed since it was signed
//   claims_conserved  an update moves custody without changing what either side would be paid if the Account closed
//   book_enforceable  the honest side's newest proof of the chain's epoch pays exactly what both agreed
//   hostage_free      (presign only) the honest side can always close the Account, whatever the other side does
//   baseline_clears   (presign only) the pre-signed baseline is above every nonce either epoch-opening event can store
module settle {
  import chain.* from "./chain"

  pure val OFFMAX = 3
  pure val NUPD = 5

  type Kind = | KPay({ from: Side, amt: int }) | KLock({ dl: int, dr: int }) | KRebase({ off: int })
  type Prop = { on: bool, author: Side, pid: int, kind: Kind }
  type View = { epoch: int, nonce: int, dispute: bool }
  // A cooperative update: signed by the side that does not submit it. `fold` is the offdelta it folds into ondelta.
  type Upd = { live: bool, epoch: int, nonce: int, dl: int, dr: int, fold: int, sigL: bool, sigR: bool }
  // tip: newest both-signed proof the Account has; next: the pre-signed baseline of the next epoch (presign);
  // locked: the pending update (0 = the Account is open for payments)
  type Acc = { tip: int, next: int, locked: int }
  type WG = { deadCommit: bool, lostPay: bool, claimBroken: bool, execs: int, commits: int, rebases: int }

  var seen: Side -> View
  var acc: Acc
  var book: int                 // the offdelta both sides agreed, across all commits (ghost)
  var prop: Prop
  var np: int                   // next free arena slot
  var upds: int -> Upd
  var nu: int
  var mode: bool                // presign
  var wg: WG

  pure val NO_UPD: Upd = { live: false, epoch: 0, nonce: 0, dl: 0, dr: 0, fold: 0, sigL: false, sigR: false }
  pure val NO_PROP: Prop = { on: false, author: Left, pid: 0, kind: KRebase({ off: 0 }) }

  pure def absI(x: int): int = if (x < 0) -x else x
  pure def payDelta(from: Side, amt: int): int = match from { | Left => -amt | Right => amt }
  pure def viewOf(a: Acct, d: Dispute): View = { epoch: a.epoch, nonce: a.nonce, dispute: d.on }
  pure def signedByU(u: Upd, s: Side): bool = match s { | Left => u.sigL | Right => u.sigR }
  // the payee of a payment frame is the side it does not come from; only a payee holding a dead proof loses anything
  pure def paidToHonest(k: Kind, hon: Side): bool = match k { | KPay(x) => x.from != hon | _ => false }
  pure def isPay(k: Kind): bool = match k { | KPay(_) => true | _ => false }
  pure def isLock(k: Kind): bool = match k { | KLock(_) => true | _ => false }
  pure def isRebase(k: Kind): bool = match k { | KRebase(_) => true | _ => false }

  // The proof a proposal carries, built from the author's own knowledge of the tip and the chain.
  pure def proofFor(k: Kind, author: Side, tp: SignedProof, sv: View): SignedProof = {
    val la = isLeft(author)
    match k {
      | KPay(x) => mkProof(true, tp.nonce + 1, tp.epoch, la, tp.offdelta + payDelta(x.from, x.amt), NO_CLAUSE, la, not(la))
      | KLock(_) => mkProof(true, tp.nonce + 1, tp.epoch, la, tp.offdelta, NO_CLAUSE, la, not(la))
      | KRebase(r) => mkProof(true, sv.nonce + 1, sv.epoch, la, r.off, NO_CLAUSE, la, not(la))
    }
  }

  // What the chain would pay each side if the Account closed on this state: the yardstick for "custody moved, claims did not".
  pure def closesTo(m: Money, coll: int, ondelta: int, off: int): Money = payout(m, coll, ondelta + off)

  // ---------------------------------------------------------------------------------------------------------
  // The baseline of the next epoch, co-signed with EVERY frame (N1, revised): a finalize can open a new epoch with no
  // settlement in sight, and then the honest side needs a proof of that epoch at once. Its nonce is a chain nonce and has to
  // be above whatever the opening event stores. The events and what they store (chain.qnt):
  //   an update          its own nonce
  //   a finalize by path 1 or 2   the nonce of the proof it adopts
  //   a timeout finalize (path 0) the nonce of the proof the dispute STARTED with, plus 1 (the start stored that nonce)
  // The proofs a counterparty can start or adopt are the ones the honest side has signed: the co-signed ones, and at most one
  // proposal of its own that is still unacked (nonce tip + 1). So the largest stored nonce is tip + 1 + 1 and the smallest
  // baseline that is still above it is tip + 3. Two is the nonce of a baseline that fails when a start uses the proposal.
  // ---------------------------------------------------------------------------------------------------------
  pure val BASELINE_GAP = 3
  pure def baselineOf(p: SignedProof, la: bool): SignedProof = mkProof(true, p.nonce + BASELINE_GAP, p.epoch + 1, la, 0, NO_CLAUSE, true, true)

  // ---------------------------------------------------------------------------------------------------------
  // The rule of the Account state machine (N1). A side runs it before it signs (as author) and before it acks.
  //   Pay, Lock  the Account is open, both the side and the proof are in the same epoch, the proof nonce follows the tip
  //   Rebase     an epoch event was observed, the Account is locked or closed, the baseline is signed for the epoch
  //              seen, above the stored nonce, and carries exactly the offdelta both agreed
  // ---------------------------------------------------------------------------------------------------------
  pure def rulesOk(sv: View, a: Acc, tp: SignedProof, bk: int, p: SignedProof, k: Kind, m: Money, coll: int): bool = and {
    not(sv.dispute),                           // a side that has started or answered a dispute knows it at once (cHonestDisputes)
    match k {
      | KPay(x) => and {
          a.locked == 0, sv.epoch == p.epoch, p.epoch == tp.epoch, p.nonce == tp.nonce + 1,
          absI(p.offdelta) <= OFFMAX
        }
      | KLock(l) => and {
          a.locked == 0, sv.epoch == p.epoch, p.epoch == tp.epoch, p.nonce == tp.nonce + 1,
          m.res.get(Left) + l.dl >= 0, m.res.get(Right) + l.dr >= 0, coll - (l.dl + l.dr) >= 0,
          l.dl != 0 or l.dr != 0
        }
      | KRebase(r) => and {
          sv.epoch > tp.epoch, p.epoch == sv.epoch, p.nonce == sv.nonce + 1, p.offdelta == bk
        }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------------------------------------

  action winit: bool = {
    nondet hon = SIDES.oneOf()
    nondet pre = Set(true, false).oneOf()
    nondet resL = 0.to(2).oneOf()
    nondet resR = 0.to(2).oneOf()
    nondet cl = 0.to(2).oneOf()
    nondet cr = 0.to(2).oneOf()
    sinit(hon, pre, resL, resR, cl, cr)
  }

  // Both sides hold a both-signed baseline at nonce 1 of epoch 0; `cl` / `cr` is what each side has put into collateral.
  action sinit(hon: Side, pre: bool, resL: int, resR: int, cl: int, cr: int): bool = {
    val base = mkProof(true, 1, 0, true, 0, NO_CLAUSE, true, true)
    all {
      arena' = SLOTS.mapBy(i => if (i == 1) base else if (i == 2 and pre) baselineOf(base, true) else NO_PROOF),
      honest' = hon,
      now' = 1,
      acct' = { nonce: 0, epoch: 0, coll: cl + cr, ondelta: cl, via: 0 },
      money' = { res: Map(Left -> resL, Right -> resR), debt: Map(Left -> 0, Right -> 0) },
      total' = resL + resR + cl + cr,
      dispute' = NO_DISPUTE,
      registry' = 0,
      knows' = Map(Left -> 0, Right -> 0),
      offline' = false,
      applied' = SLOTS.mapBy(_ => false),
      ghost' = { badApply: false, clauseMiss: false, nonceBack: false, appliedTwice: false, freeDebt: false,
                 xWasOffline: false, finalizes: 0, lastApplied: 0 },
      seen' = SIDES.mapBy(_ => { epoch: 0, nonce: 0, dispute: false }),
      acc' = { tip: 1, next: if (pre) 2 else 0, locked: 0 },
      book' = 0,
      prop' = NO_PROP,
      np' = if (pre) 3 else 2,
      upds' = 0.to(NUPD - 1).mapBy(_ => NO_UPD),
      nu' = 1,
      mode' = pre,
      wg' = { deadCommit: false, lostPay: false, claimBroken: false, execs: 0, commits: 0, rebases: 0 }
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
  action offPropose(author: Side, k: Kind): bool = {
    val tp = arena.get(acc.tip)
    val sv = seen.get(author)
    val p = proofFor(k, author, tp, sv)
    all {
      not(prop.on), np < NREC, nu < NUPD,
      match k { | KPay(x) => x.from == author | _ => true },
      (author == honest) implies rulesOk(sv, acc, tp, book, p, k, money, acct.coll),
      arena' = arena.set(np, p),
      prop' = { on: true, author: author, pid: np, kind: k },
      np' = np + 1,
      keepChain,
      seen' = seen, acc' = acc, book' = book, upds' = upds, nu' = nu, mode' = mode, wg' = wg
    }
  }

  // an offer nobody answers: it lapses, its signature stays in the world (the counterparty may use it in a dispute)
  action abandon: bool = all {
    prop.on, prop' = NO_PROP,
    keepChain,
    arena' = arena, seen' = seen, acc' = acc, book' = book, np' = np, upds' = upds, nu' = nu, mode' = mode, wg' = wg
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
      arena' = if (mode) arena.set(prop.pid, { ...p, sigL: true, sigR: true }).set(np, baselineOf(p, isLeft(prop.author)))
               else arena.set(prop.pid, { ...p, sigL: true, sigR: true }),
      np' = if (mode) np + 1 else np,
      acc' = { ...acc, tip: prop.pid, next: if (mode) np else acc.next },
      book' = p.offdelta,
      prop' = NO_PROP,
      wg' = { ...wg, deadCommit: wg.deadCommit or (p.epoch != acct.epoch and paidToHonest(prop.kind, honest)), commits: wg.commits + 1 },
      keepChain,
      seen' = seen, upds' = upds, nu' = nu, mode' = mode
    }
  }

  // A Lock commits the update the two sides intend to execute. From here payments pause. In presign mode the frame co-signs
  // the baseline of the next epoch, as every frame does.
  action ackLock: bool = {
    val p = arena.get(prop.pid)
    val acker = other(prop.author)
    val lk = match prop.kind { | KLock(l) => l | _ => { dl: 0, dr: 0 } }
    val u: Upd = { live: true, epoch: p.epoch, nonce: p.nonce + 1, dl: lk.dl, dr: lk.dr, fold: p.offdelta,
                   sigL: false, sigR: false }
    val baseline = baselineOf(p, isLeft(prop.author))
    all {
      prop.on, isLock(prop.kind),
      ackable(prop, seen, acc, arena.get(acc.tip), book, p, money, acct.coll, honest),
      arena' = if (mode) arena.set(prop.pid, { ...p, sigL: true, sigR: true }).set(np, baseline)
               else arena.set(prop.pid, { ...p, sigL: true, sigR: true }),
      np' = if (mode) np + 1 else np,
      acc' = { tip: prop.pid, next: if (mode) np else 0, locked: nu },
      upds' = upds.set(nu, u),
      nu' = nu + 1,
      prop' = NO_PROP,
      wg' = { ...wg, commits: wg.commits + 1 },
      keepChain,
      seen' = seen, book' = book, mode' = mode
    }
  }

  action ackRebase: bool = {
    val p = arena.get(prop.pid)
    val acker = other(prop.author)
    all {
      prop.on, isRebase(prop.kind),
      ackable(prop, seen, acc, arena.get(acc.tip), book, p, money, acct.coll, honest),
      arena' = arena.set(prop.pid, { ...p, sigL: true, sigR: true }),
      acc' = { tip: prop.pid, next: 0, locked: 0 },
      prop' = NO_PROP,
      wg' = { ...wg, commits: wg.commits + 1, rebases: wg.rebases + 1 },
      keepChain,
      seen' = seen, book' = book, np' = np, upds' = upds, nu' = nu, mode' = mode
    }
  }

  // A side reads the chain. In presign mode the pre-signed baseline becomes the tip the moment the epoch it was signed
  // for is the chain's, by whichever event.
  action observe(s: Side): bool = all {
    seen.get(s) != viewOf(acct, dispute),
    seen' = seen.set(s, viewOf(acct, dispute)),
    acc' = if (mode and acc.next != 0 and arena.get(acc.next).epoch == acct.epoch) { tip: acc.next, next: 0, locked: 0 } else acc,
    keepChain,
    arena' = arena, book' = book, prop' = prop, np' = np, upds' = upds, nu' = nu, mode' = mode, wg' = wg
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
      arena' = arena, seen' = seen, acc' = acc, book' = book, prop' = prop, np' = np, nu' = nu, mode' = mode, wg' = wg
    }
  }

  // Depository processSettlements: submitted by `x`, signed by the other side. The epoch, the nonce, custody and the
  // absence of a dispute are the contract's guards. A cooperative update moves nonce to its own value and opens epoch+1.
  action execUpd(x: Side, uid: int): bool = {
    val u = upds.get(uid)
    val dColl = -(u.dl + u.dr)
    val dOn = -u.dl + (if (mode) u.fold else 0)
    val m2: Money = { res: money.res.set(Left, money.res.get(Left) + u.dl).set(Right, money.res.get(Right) + u.dr), debt: money.debt }
    val offAfter = if (mode) 0 else book
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
      seen' = seen, acc' = acc, prop' = prop, np' = np, upds' = upds, nu' = nu, mode' = mode
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // The chain's own actions, with the honest side reading the chain first
  // ---------------------------------------------------------------------------------------------------------

  // the honest side holds a both-signed proof of the chain's epoch that a dispute could start with
  val startable: bool = RECS.exists(i => canStart({ ar: arena, a: acct, d: dispute }, honest, i))

  // the honest side is up to date on what matters for signing: the epoch and whether a dispute runs (the nonce it reads on observe)
  val fresh: bool = seen.get(honest).epoch == acct.epoch and seen.get(honest).dispute == dispute.on

  action keepSettle: bool = all {
    seen' = seen, acc' = acc, book' = book, prop' = prop, np' = np, upds' = upds, nu' = nu, mode' = mode, wg' = wg
  }

  action cNeutral(a: bool): bool = all { a, keepSettle }
  action cHonest(a: bool): bool = all { fresh, a, keepSettle }
  // the honest side that starts or answers a dispute knows it from that moment: it stops signing before it has read the block
  action cHonestDisputes(a: bool): bool = all {
    fresh, a,
    seen' = seen.set(honest, { ...seen.get(honest), dispute: true }),
    acc' = acc, book' = book, prop' = prop, np' = np, upds' = upds, nu' = nu, mode' = mode, wg' = wg
  }
  // a finalize pays everything out: the new epoch starts from nothing
  action cFinalize(a: bool): bool = all {
    a,
    book' = 0,
    seen' = seen, acc' = acc, prop' = prop, np' = np, upds' = upds, nu' = nu, mode' = mode, wg' = wg
  }

  action wstep = any {
    cHonest(tick),                        // time passes only when the honest side has read the chain (the lag bound)
    cNeutral(learn(Left)), cNeutral(learn(Right)),
    cNeutral(publish(Left)), cNeutral(publish(Right)),
    cNeutral(setOffline(true)), cNeutral(setOffline(false)),
    // a side funds its own share; the honest side does so only into an Account it holds a proof for (S: fund after open)
    { nondet a = 1.to(2).oneOf() nondet who = SIDES.oneOf() cNeutral(all { who != honest or startable, r2c(who, who, a) }) },
    cNeutral(adversaryStart), cHonestDisputes(honestStart),
    cNeutral(adversaryCounter), cHonestDisputes(honestCounter),
    cFinalize(adversaryFinalize), cFinalize(all { fresh, honestFinalize }),
    { nondet who = SIDES.oneOf() nondet a = 1.to(2).oneOf() offPropose(who, KPay({ from: who, amt: a })) },
    { nondet who = SIDES.oneOf() nondet l = (-1).to(1).oneOf() nondet r = (-1).to(1).oneOf() offPropose(who, KLock({ dl: l, dr: r })) },
    { nondet who = SIDES.oneOf() nondet o = (-1).to(1).oneOf() offPropose(who, KRebase({ off: o })) },
    ackPay, ackLock, ackRebase, abandon,
    observe(Left), observe(Right),
    { nondet who = SIDES.oneOf() nondet uid = 1.to(NUPD - 1).oneOf() signUpd(who, uid) },
    { nondet who = SIDES.oneOf() nondet uid = 1.to(NUPD - 1).oneOf() all { who != honest or fresh, execUpd(who, uid) } }
  }

  // The settlement lifecycle alone, without the chain's dispute noise: random search reaches deep schedules (pay, lock,
  // sign, execute, read, rebase) far more often. Used to hunt mutants; the full `wstep` is the one that must stay green.
  action wfocus = any {
    { nondet who = SIDES.oneOf() nondet a = 1.to(2).oneOf() offPropose(who, KPay({ from: who, amt: a })) },
    { nondet who = SIDES.oneOf() nondet l = (-1).to(1).oneOf() nondet r = (-1).to(1).oneOf() offPropose(who, KLock({ dl: l, dr: r })) },
    { nondet who = SIDES.oneOf() nondet o = (-1).to(1).oneOf() offPropose(who, KRebase({ off: o })) },
    ackPay, ackLock, ackRebase,
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

  // The pre-signed baseline (presign) is usable whichever event opens its epoch. A start needs a proof nonce above the stored
  // one, and the events store at most: an update its nonce; a finalize the nonce of what it adopts, or, for a timeout, the
  // nonce the dispute started with plus 1. What can be started or adopted is what the honest side has signed. So before the
  // event the baseline must clear the highest nonce the honest side has signed for the epoch, plus 1, and the update's
  // nonce; after it, the stored nonce (a dispute that started with the baseline itself has stored its nonce). The frame
  // height of the Account has no part in this: only chain nonces do.
  def signedNonce(e: int): int = RECS.fold(0, (m, i) =>
    if (arena.get(i).live and arena.get(i).epoch == e and signedBy(arena.get(i), honest)) imax(m, arena.get(i).nonce) else m)

  val baseline_clears: bool = or {
    acc.next == 0,
    {
      val b = arena.get(acc.next)
      val u = upds.get(acc.locked)
      if (acct.epoch == b.epoch) dispute.on or b.nonce > acct.nonce            // a start stores the nonce of the proof it used
      else if (acct.epoch > b.epoch) true
      else and { b.nonce > signedNonce(b.epoch - 1) + 1, b.nonce > acct.nonce + 1, b.nonce > u.nonce }
    }
  }

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
  val hostage_free: bool = not(mode) or exit_ok

  val wsafe: bool = and { safe, no_dead_commit, no_lost_pay, claims_conserved, book_enforceable, hostage_free, baseline_clears }

  // coverage: each must be violated by some run
  val w_no_lock: bool = acc.locked == 0
  val w_no_update: bool = wg.execs == 0
  val w_no_second_epoch: bool = acct.epoch < 2
  val w_no_rebase: bool = wg.rebases == 0
  val w_no_payment: bool = book == 0
  val w_no_adoption: bool = not(mode and wg.execs > 0 and acct.epoch > 0 and arena.get(acc.tip).epoch == acct.epoch)
  // in the N1-as-decided mode a settled Account can be left without a proof for its epoch: a state that cannot close
  val w_hostage: bool = mode or exit_ok
}
