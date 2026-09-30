// XLN J layer, part two: the Entity's batch to the jurisdiction. Everything the Entity does on chain goes in a batch.
//
// The chain facts (contracts/contracts/Depository.sol processBatch and _processBatch):
//   - a batch is signed for one entity and one nonce and lands only when nonce = stored nonce + 1 (E2 otherwise); landing stores the
//     nonce; a batch that reverts leaves no trace, not even the nonce;
//   - a batch is atomic: one op that reverts (an R2R the reserve cannot cover, a dispute start over a dispute that moved) reverts
//     the whole batch, and a signed batch never expires: anybody can submit it, again, at any later time;
//   - with the tolerant contract (J2) a dispute op that cannot apply is skipped and the chain emits
//     DisputeOpSkipped(sender, counterentity, op, reason, nonce): a start beside an open dispute (there is at most one dispute per
//     Account), a counter after the window closed, an op that already ran. That event is how the Entity learns the op is dead;
//   - the ops of a batch run in a fixed order (deposits, R2R, C2R, settlements, dispute starts, counters, secret reveals,
//     finalizations, R2C, withdrawals), so one batch can reveal a secret and finalize with it.
//
// What this module answers (QUESTIONS.md J1 to J4):
//   - what a lost, dropped or reverted batch does to the ops and the reserve it held (Q-J1): nothing is lost, and the Entity abandons
//     only ops that can never apply, because a signed batch can land later;
//   - what the fate sharing of one batch and the strict nonce cost the deadline arithmetic of the urgent ops (secret reveals and
//     dispute steps), and which contract behaviour and which Entity packing keep an urgent op inside LAG.
//
// F1 (coordinator, from the J2 review): processBatch is permissionless and a batch whose ops are all stale lands as a no-op and still
// takes its nonce, so a signed batch is final at its nonce: the Entity never signs other content at a signed nonce and always sends a
// replacement at a fresh one. J5 (proposal): a batch that fails takes its nonce too, or one failed payment holds every batch above it.
//
// The model: one Entity, one token, four ops with a kind, an arrival time and a deadline. The honest relayer submits every batch the
// Entity signs, in ascending nonce order, and each first attempt happens within LAG. The adversary chooses which of several batches
// signed for one nonce lands, spoils dispute ops (`poison`: the dispute an op belongs to moved on), moves the reserve (`drain`,
// `refill`) and re-submits any batch ever signed. The Entity reads every outcome at once (its reaction time is zero, the same
// assumption as entity.qnt). Simulation only.
module jbatch {
  // ---------------------------------------------------------------------------------------------------------
  // Parameters
  // ---------------------------------------------------------------------------------------------------------

  pure val LAG = 1               // a submitted batch is attempted within LAG, and the Entity reads the outcome then
  pure val MAXT = 8
  pure val OPIDS = 1.to(4)
  pure val RESERVE_MAX = 3
  // chain: does a dispute op that cannot apply revert the whole batch (Depository today) or is it skipped? [J2]
  pure val TOLERANT = true
  // Entity: how it packs and signs. 0 = one batch of everything queued, one batch outstanding (the naive way); 4 = urgent ops alone,
  // and a signed batch is final at its nonce: content is never signed again at a signed nonce, every replacement goes to a fresh one
  // [J3, F1].
  pure val STRAT = 4
  // chain: a batch that reverts (a payment the reserve cannot cover) still takes its nonce and applies nothing [J5, proposal]; today it
  // leaves no trace and its nonce stays open, so it blocks every batch above it.
  pure val NONCE_ON_FAIL = true
  // J5 as built: only a batch with no dispute, reveal or hash-ladder op gets that treatment; a mixed batch that fails still reverts whole
  // and keeps its nonce open. So the Entity splits its batches (R-SPLIT): urgent ops never share a batch with payment, settlement or
  // reserve ops (Entity side: `plan`).
  // chain: a batch failure is reported (BatchFailed, nonce spent) only when the self-call got at least BATCH_GAS_FLOOR; below the floor the transaction
  // reverts and takes no nonce, so a relayer that starves a good batch cannot burn its nonce. With the floor, an empty revert reason at or above it is
  // BatchFailed(0) and spends the nonce (the same soft failure as any other). This replaces the earlier 1/32 rule and the ERC-1271 stipend.
  pure val GAS_GUARD = true
  // J5 refinement (coordinator, from the #54 review): a batch that carries a deposit leg (externalTokenToReserve) reverts whole, like a
  // dispute batch, and never soft-fails: a relayer or a paused token cannot burn its nonce. A bad counterparty signature inside a batch
  // (a settlement or C2R signed at an old account epoch: `Settle` poisoned) is a soft fail; only a failure of the batch's own hanko
  // authorisation reverts without taking the nonce (`forge`).
  pure val DEP_SOFT_FAILS = false
  pure val SIMULATE_DEPOSITS = true       // J6: a deposit batch is signed only when it simulates successfully
  // Entity: after it gives a signed draft up, a payment, deposit or reserve move in it stays "in flight" until the batch's nonce is used
  // (and BatchFailed read, if it failed): the signed batch can still land, and such an op runs every time. Only urgent ops (dispute step,
  // reveal, hash ladder), which run once or are skipped, go back into the draft at once [coordinator rule, F1].
  pure val PAY_HELD_AFTER_ABORT = true

  // ---------------------------------------------------------------------------------------------------------
  // Domain model
  // ---------------------------------------------------------------------------------------------------------

  // Pay: a reserve transfer (reverts when the reserve cannot cover it; runs every time its batch lands). Reveal: a secret goes on the
  // chain (cannot revert). Disp: a dispute start, counter or finalize (reverts when the dispute moved: `poisoned`). Reveal and Disp are
  // urgent; a batch that lands a second time skips an urgent op that already ran.
  type Kind = | Pay | Reveal | Disp | Dep | Settle
  type Op = { kind: Kind, amt: int, arr: int, dl: int }         // it reaches the Entity at `arr`; on the chain by `dl` (0 = no deadline)
  type Batch = { nonce: int, ids: Set[int] }
  type Sub = { b: Batch, at: int, tried: bool, last: int, aband: bool }       // submitted at `at`; `last` = the tick of its latest attempt; `aband`: the Entity gave the draft up (the signed copy is still out there)

  type Ghost = {
    landed: int,               // batches that landed
    missed: bool,              // an urgent op passed its deadline, still owed and alive
    reverts: int, forks: int, failed: int,
    burned: bool,              // a batch that would have applied was failed at its nonce (a starved relayer call)
    depBurned: bool,           // a batch with a deposit leg failed softly and took its nonce (J5 refinement: it must revert whole)
    forgedLanded: bool,        // a batch that the Entity did not sign took a nonce
    hostage: bool              // an urgent op went past its deadline behind a deposit batch that cannot land (the cost of revert-whole)
  }

  type S = {
    now: int,
    ops: int -> Op,
    arrived: int -> bool,
    dropped: int -> bool,             // the Entity abandoned the op
    sub: List[Sub],                   // every batch the Entity signed and submitted
    cnonce: int,                      // chain: the stored nonce
    ext: bool,                        // chain: the token transfer behind a deposit leg works (false: the token is paused, an allowance is gone)
    reserve: int,                     // chain: the Entity's reserve
    done: int -> bool,                // chain: the op ran
    runs: int -> int,                 // chain: how many times the op ran
    poisoned: int -> bool,            // chain: the op's dispute moved: it can never apply
    skipped: int -> bool,             // chain: DisputeOpSkipped was emitted for the op (J2)
    failedEv: int -> int,             // chain: BatchFailed events emitted for a batch that carried the payment (J5)
    failSeen: int -> int,             // the Entity has read that many
    gh: Ghost
  }

  pure val NO_GHOST: Ghost = { landed: 0, missed: false, reverts: 0, forks: 0, failed: 0, burned: false, depBurned: false, forgedLanded: false, hostage: false }

  var st: S

  // ---------------------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------------------

  // money ops run every time their batch lands and can fail it: a payment, a deposit leg, a settlement. Urgent ops (reveal, dispute step) run once or are skipped.
  pure def isMoney(s: S, i: int): bool = match s.ops.get(i).kind { | Pay => true | Dep => true | Settle => true | _ => false }
  pure def isPayOnly(s: S, i: int): bool = match s.ops.get(i).kind { | Pay => true | _ => false }
  pure def isDep(s: S, i: int): bool = match s.ops.get(i).kind { | Dep => true | _ => false }
  pure def isSettle(s: S, i: int): bool = match s.ops.get(i).kind { | Settle => true | _ => false }
  pure def isDisp(s: S, i: int): bool = match s.ops.get(i).kind { | Disp => true | _ => false }
  pure def payTotal(s: S, ids: Set[int]): int = ids.fold(0, (m, i) => if (isPayOnly(s, i)) m + s.ops.get(i).amt else m)
  pure def depTotal(s: S, ids: Set[int]): int = ids.fold(0, (m, i) => if (isDep(s, i)) m + s.ops.get(i).amt else m)
  pure def hasDep(s: S, ids: Set[int]): bool = ids.exists(i => isDep(s, i))
  // the Account a co-signed op belongs to: ops 1 and 2 are on Account 1, ops 3 and 4 on Account 2
  pure def acctOf(i: int): int = if (i <= 2) 1 else 2

  pure def anySub(s: S, f: Sub => bool): bool = s.sub.foldl(false, (a, x) => a or f(x))
  pure def alive(s: S, x: Sub): bool = x.b.nonce > s.cnonce          // its nonce is not used yet: it can still land

  // the Entity's view of an op
  pure def pending(s: S, i: int): bool = s.arrived.get(i) and not(s.done.get(i)) and not(s.dropped.get(i))
  // After an abort the signed batch can still land. An urgent op (idempotent: it runs once, or is skipped) goes back into the draft at
  // once; a payment, deposit or reserve move (it runs every time) only once its batch's nonce is used, and once the Entity has read
  // BatchFailed if the batch failed (PAY_HELD_AFTER_ABORT).
  pure def inFlight(s: S, i: int): bool =
    anySub(s, x => alive(s, x) and x.b.ids.contains(i) and (not(x.aband) or (isMoney(s, i) and PAY_HELD_AFTER_ABORT)))

  // ---------------------------------------------------------------------------------------------------------
  // The chain: processBatch
  // ---------------------------------------------------------------------------------------------------------

  pure def applies(s: S, b: Batch): bool = and {
    b.nonce == s.cnonce + 1,
    payTotal(s, b.ids) <= s.reserve + depTotal(s, b.ids),      // the deposit legs run first and fund the payments behind them
    not(hasDep(s, b.ids)) or s.ext,
    b.ids.forall(i => not(isSettle(s, i) and s.poisoned.get(i))),   // a counterparty signature at a dead epoch
    TOLERANT or b.ids.forall(i => not(isDisp(s, i) and s.poisoned.get(i)))
  }

  // What running the batch does: a payment runs each time, an urgent op runs once and only if its dispute did not move.
  pure def skippedBy(s: S, b: Batch): Set[int] =
    b.ids.filter(i => isDisp(s, i) and not(s.done.get(i)) and s.poisoned.get(i))

  pure def landOn(s: S, b: Batch): S =
    if (applies(s, b)) {
      val ran = b.ids.filter(i => isMoney(s, i) or (not(s.done.get(i)) and not(s.poisoned.get(i))))
      { ...s,
        skipped: OPIDS.mapBy(i => s.skipped.get(i) or skippedBy(s, b).contains(i)),
        cnonce: b.nonce,
        reserve: s.reserve + depTotal(s, b.ids) - payTotal(s, b.ids),
        done: OPIDS.mapBy(i => s.done.get(i) or ran.contains(i)),
        runs: OPIDS.mapBy(i => s.runs.get(i) + (if (ran.contains(i)) 1 else 0)),
        gh: { ...s.gh, landed: s.gh.landed + 1 } }
    } else if (NONCE_ON_FAIL and b.nonce == s.cnonce + 1 and b.ids.forall(i => isMoney(s, i)) and (DEP_SOFT_FAILS or not(hasDep(s, b.ids))))   // R-SPLIT: never for a batch with an urgent op; J5: never for one with a deposit leg
      // the transaction itself succeeds: the failure is caught, its effects are undone, the nonce is stored and BatchFailed is emitted
      { ...s, cnonce: b.nonce,
        failedEv: OPIDS.mapBy(i => s.failedEv.get(i) + (if (b.ids.contains(i) and isMoney(s, i)) 1 else 0)),
        gh: { ...s.gh, landed: s.gh.landed + 1, failed: s.gh.failed + 1, depBurned: s.gh.depBurned or hasDep(s, b.ids) } }
    else { ...s, gh: { ...s.gh, reverts: s.gh.reverts + 1 } }

  // ---------------------------------------------------------------------------------------------------------
  // The Entity: what it signs
  // ---------------------------------------------------------------------------------------------------------

  pure def urgentPending(s: S): Set[int] = OPIDS.filter(i => pending(s, i) and not(isMoney(s, i)))
  // a payment whose batch failed is queued again only once the Entity has read the BatchFailed event
  pure def payQueued(s: S): Set[int] = OPIDS.filter(i => pending(s, i) and isMoney(s, i) and not(inFlight(s, i)) and s.failSeen.get(i) == s.failedEv.get(i))

  pure def nothingAlive(s: S): bool = not(anySub(s, x => alive(s, x) and (not(x.aband) or PAY_HELD_AFTER_ABORT)))

  // the highest nonce signed so far, or the stored one: the next fresh nonce is above it
  pure def topSigned(s: S): int = s.sub.foldl(s.cnonce, (m, x) => if (x.b.nonce > m) x.b.nonce else m)

  // the co-signed ops of the lowest Account that has any
  pure def coSigned(s: S, p: Set[int]): Set[int] = {
    val cs = p.filter(i => isSettle(s, i))
    val a = cs.fold(3, (m, i) => if (acctOf(i) < m) acctOf(i) else m)
    cs.filter(i => acctOf(i) == a)
  }

  pure def plan(s: S): List[Batch] = {
    val u = urgentPending(s)
    val p = payQueued(s)
    val q = u.union(p)
    val f = topSigned(s) + 1
    if (STRAT == 0) (if (nothingAlive(s) and q.size() > 0) [{ nonce: s.cnonce + 1, ids: q }] else [])
    else {
      // F1: every batch goes to a nonce nobody has signed. An urgent op that is in no live batch gets a batch of its own (no payment
      // in it); payments wait until nothing is outstanding. A batch that is no longer wanted still lands as a no-op and takes its
      // own nonce, which costs nothing: the batches above it land right behind it in the same round.
      val fresh = u.filter(i => not(inFlight(s, i)))
      if (fresh.size() > 0) [{ nonce: f, ids: fresh }]
      // a deposit leg reverts its batch whole (J5 refinement), so it travels alone: the payments behind it wait for the next round. The Runtime
      // signs a deposit batch only after simulating it successfully (`s.ext`: the token works now, J6); a token paused between the simulation and the
      // landing stalls the nonce, a residual risk the coordinator accepted.
      else if (nothingAlive(s) and p.filter(i => isDep(s, i)).size() > 0)
        (if (s.ext or not(SIMULATE_DEPOSITS)) [{ nonce: f, ids: p.filter(i => isDep(s, i)) }] else [])
      // R-COSIGN (coordinator, #54 review): a batch that carries a co-signed op (a settlement or C2R) carries ops for that one Account only.
      // A counterparty's state change or a relayer's gas choice can fail such a batch, so nothing unrelated may ride with it.
      else if (nothingAlive(s) and p.filter(i => isSettle(s, i)).size() > 0) [{ nonce: f, ids: coSigned(s, p) }]
      else if (nothingAlive(s) and p.size() > 0) [{ nonce: f, ids: p }]
      else []
    }
  }

  pure def submit(s: S, bs: List[Batch]): S =
    { ...s, sub: s.sub.concat(bs.foldl([], (acc, b) => acc.append({ b: b, at: s.now, tried: false, last: 0, aband: false }))) }

  pure def react(s: S): S = submit(s, plan(s))

  // ---------------------------------------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------------------------------------

  // scenario tests start from a chosen catalogue
  action initFrom(ops: int -> Op, reserve: int): bool = st' = {
    now: 1, ops: ops,
    arrived: OPIDS.mapBy(_ => false), dropped: OPIDS.mapBy(_ => false), sub: [],
    cnonce: 0, ext: true, reserve: reserve,
    done: OPIDS.mapBy(_ => false), runs: OPIDS.mapBy(_ => 0), poisoned: OPIDS.mapBy(_ => false), skipped: OPIDS.mapBy(_ => false),
    failedEv: OPIDS.mapBy(_ => 0), failSeen: OPIDS.mapBy(_ => 0),
    gh: NO_GHOST
  }

  action init = {
    nondet a1 = 1.to(2).oneOf()
    nondet a2 = 1.to(3).oneOf()
    nondet a3 = 1.to(3).oneOf()
    nondet a4 = 1.to(3).oneOf()
    nondet m1 = 1.to(2).oneOf()
    nondet m4 = 1.to(2).oneOf()
    nondet k1 = 0.to(2).oneOf()
    nondet k4 = 0.to(3).oneOf()
    st' = {
      now: 1,
      ops: Map(
        1 -> { kind: (if (k1 == 2) Settle else Pay), amt: m1, arr: a1, dl: 0 },
        2 -> { kind: Reveal, amt: 0, arr: a2, dl: a2 + LAG },
        3 -> { kind: Disp, amt: 0, arr: a3, dl: a3 + LAG },
        4 -> { kind: (if (k4 == 1) Dep else if (k4 >= 2) Settle else Pay), amt: m4, arr: a4, dl: 0 }
      ),
      arrived: OPIDS.mapBy(_ => false), dropped: OPIDS.mapBy(_ => false), sub: [],
      cnonce: 0, ext: true, reserve: RESERVE_MAX,
      done: OPIDS.mapBy(_ => false), runs: OPIDS.mapBy(_ => 0), poisoned: OPIDS.mapBy(_ => false), skipped: OPIDS.mapBy(_ => false),
      failedEv: OPIDS.mapBy(_ => 0), failSeen: OPIDS.mapBy(_ => 0),
      gh: NO_GHOST
    }
  }

  // an op reaches the Entity
  action arrive(i: int): bool = all {
    not(st.arrived.get(i)), st.ops.get(i).arr <= st.now,
    st' = react({ ...st, arrived: st.arrived.set(i, true) })
  }

  // everything due reaches the Entity in one frame
  action arriveDue: bool = all {
    arrivalDue(st),
    st' = react({ ...st, arrived: OPIDS.mapBy(i => st.arrived.get(i) or st.ops.get(i).arr <= st.now) })
  }

  // a submitted batch is attempted. The honest relayer attempts in ascending nonce order; the adversary picks among the copies of
  // one nonce, and may attempt any batch again. The Entity abandons an op it reads DisputeOpSkipped for (its dispute moved) and only that;
  // when the contract reverts instead (J2 off) it sees the revert and the moved dispute.
  pure def afterAttempt(s: S, j: int, honest: bool): S = {
    val x = s.sub[j]
    val s1 = landOn(s, x.b)
    // the Entity abandons what can never apply: a skipped dispute op, and a settlement whose counterparty signature is at a dead epoch
    // (it needs a fresh co-signature, which is a new op)
    val dead = (if (TOLERANT) x.b.ids.filter(i => s1.skipped.get(i)) else x.b.ids.filter(i => isDisp(s, i) and s.poisoned.get(i)))
                 .union(x.b.ids.filter(i => isSettle(s, i) and s.poisoned.get(i)))
    react({ ...s1,
      failSeen: OPIDS.mapBy(i => if (x.b.ids.contains(i)) s1.failedEv.get(i) else s.failSeen.get(i)),
      dropped: OPIDS.mapBy(i => s.dropped.get(i) or dead.contains(i)),
      sub: s.sub.foldl([], (acc, y) => acc.append(if (y == x and honest) { ...y, tried: true, last: s.now } else y)) })
  }

  action attempt(j: int): bool = all {
    j >= 0, j < st.sub.length(),
    // ascending: every live batch with a lower nonce has been attempted this tick
    not(anySub(st, y => alive(st, y) and y.b.nonce < st.sub[j].b.nonce and y.last < st.now)),
    st' = afterAttempt(st, j, true)
  }

  // A relayer that is not the honest one: any batch ever signed, in any order, at any time. The chain refuses whatever is not next (E2);
  // it does not count as the first attempt the Entity is owed.
  action attemptAny(j: int): bool = all {
    j >= 0, j < st.sub.length(),
    st' = afterAttempt(st, j, false)
  }

  // A batch the Entity never signed: its hanko does not verify. The transaction reverts, and the nonce is not taken.
  action forge: bool = all {
    st.now <= MAXT,
    st' = react({ ...st, gh: { ...st.gh, reverts: st.gh.reverts + 1 } })
  }

  // The token behind a deposit leg stops working (paused, allowance gone, the depositor's funds moved) and comes back.
  action extLose: bool = all { st.ext, st' = react({ ...st, ext: false }) }
  action extBack: bool = all { not(st.ext), st' = react({ ...st, ext: true }) }

  // A relayer that gives the call too little gas. With the guard the transaction reverts and nothing happens, the batch stays valid.
  // Without it the batch is failed at its nonce (BatchFailed), good or not, and a payment batch that would have applied is burnt.
  action starve(j: int): bool = {
    val x = st.sub[j]
    val b = x.b
    val burns = not(GAS_GUARD) and b.nonce == st.cnonce + 1 and b.ids.forall(i => isMoney(st, i))
    val s1 = if (burns) { ...st, cnonce: b.nonce,
                          failedEv: OPIDS.mapBy(i => st.failedEv.get(i) + (if (b.ids.contains(i)) 1 else 0)),
                          gh: { ...st.gh, landed: st.gh.landed + 1, failed: st.gh.failed + 1, burned: st.gh.burned or applies(st, b) } }
             else { ...st, gh: { ...st.gh, reverts: st.gh.reverts + 1 } }
    all {
      j >= 0, j < st.sub.length(),
      st' = react({ ...s1, failSeen: OPIDS.mapBy(i => if (b.ids.contains(i)) s1.failedEv.get(i) else st.failSeen.get(i)) })
    }
  }

  // The Entity gives a signed draft up (a rolled-back frame, a restart that lost the outbox): the signed batch is not recalled.
  action abort(j: int): bool = {
    val x = st.sub[j]
    all {
      j >= 0, j < st.sub.length(),
      alive(st, x), not(x.aband),
      st' = react({ ...st, sub: st.sub.foldl([], (acc, y) => acc.append(if (y == x) { ...y, aband: true } else y)) })
    }
  }

  action poison(i: int): bool = all {
    isDisp(st, i) or isSettle(st, i), not(st.done.get(i)), not(st.poisoned.get(i)),
    st' = { ...st, poisoned: st.poisoned.set(i, true) }
  }
  action drain(a: int): bool = all { a >= 1, a <= st.reserve, st' = react({ ...st, reserve: st.reserve - a }) }
  action refill(a: int): bool = all { a >= 1, st.reserve + a <= RESERVE_MAX, st' = react({ ...st, reserve: st.reserve + a }) }

  pure def overdue(s: S): bool = anySub(s, x => not(x.tried) and s.now >= x.at + LAG)
  pure def arrivalDue(s: S): bool = OPIDS.exists(i => not(s.arrived.get(i)) and s.ops.get(i).arr <= s.now)
  // an urgent op whose deadline is this tick and is still owed when the clock moves on
  pure def lateNow(s: S): bool = OPIDS.exists(i => and {
    not(isMoney(s, i)), s.ops.get(i).dl == s.now, not(s.done.get(i)), not(s.poisoned.get(i))
  })

  // a deposit batch that cannot land sits at the next nonce: it holds every batch above it, urgent ones too (revert-whole has this cost)
  pure def hostage(s: S): bool = anySub(s, x => alive(s, x) and x.b.nonce == s.cnonce + 1 and hasDep(s, x.b.ids) and not(s.ext))

  action tick: bool = all {
    st.now <= MAXT, not(overdue(st)), not(arrivalDue(st)),
    st' = { ...st, now: st.now + 1,
            gh: { ...st.gh, missed: st.gh.missed or (lateNow(st) and not(hostage(st))), hostage: st.gh.hostage or (lateNow(st) and hostage(st)) } }
  }

  action step = any {
    tick,
    { nondet i = OPIDS.oneOf() arrive(i) },
    arriveDue,
    { nondet j = 0.to(9).oneOf() attempt(j) },
    { nondet j = 0.to(9).oneOf() attemptAny(j) },
    forge,
    extLose,
    extBack,
    { nondet j = 0.to(9).oneOf() starve(j) },
    { nondet j = 0.to(9).oneOf() abort(j) },
    { nondet i = OPIDS.oneOf() poison(i) },
    { nondet a = 1.to(2).oneOf() drain(a) },
    { nondet a = 1.to(2).oneOf() refill(a) }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------------------------------------

  // J3: an urgent op lands inside LAG of reaching the Entity, or its dispute moved.
  val urgent_lands: bool = not(st.gh.missed)
  // Q-J1: the Entity abandons only ops that can never apply.
  val dropped_only_dead: bool = OPIDS.forall(i => not(st.dropped.get(i)) or st.poisoned.get(i))
  // J2: every DisputeOpSkipped event is read and its op abandoned: without that the Entity waits for an outcome that never comes.
  val skip_read: bool = OPIDS.forall(i => not(st.skipped.get(i)) or st.dropped.get(i))
  // F1: a signed batch is final at its nonce: the Entity never signs different content at a nonce it has already signed.
  val nonce_final: bool = st.sub.foldl(true, (ok, x) => ok and st.sub.foldl(true, (ok2, y) => ok2 and (x.b.nonce != y.b.nonce or x.b == y.b)))
  // J5: every BatchFailed event is read and its payment queued again: without it the payment is signed for ever after.
  val failed_read: bool = OPIDS.forall(i => st.failSeen.get(i) == st.failedEv.get(i))
  // A starved relayer call never burns a good batch (gas guard).
  val no_burn: bool = not(st.gh.burned)
  // a payment runs at most once: the signed batch that carries it can land only once per nonce, and the Entity never
  // signs it again while an older batch that carries it can still land.
  val pay_once: bool = OPIDS.forall(i => not(isMoney(st, i)) or st.runs.get(i) <= 1)
  // an urgent op runs at most once
  val urgent_once: bool = OPIDS.forall(i => isMoney(st, i) or st.runs.get(i) <= 1)
  // the nonce moves by one per landed batch
  val nonce_sequential: bool = st.cnonce == st.gh.landed
  // the reserve is the initial one, less what payments ran, plus what was refilled (checked by payments never overspending)
  val reserve_sound: bool = st.reserve >= 0 and st.reserve <= RESERVE_MAX + depTotal(st, OPIDS)

  // J5 refinement: a batch with a deposit leg never takes its nonce by failing.
  val dep_never_burns: bool = not(st.gh.depBurned)
  // Only a batch the Entity signed can take a nonce (a forged hanko reverts without one).
  val only_signed_land: bool = not(st.gh.forgedLanded)

  // R-COSIGN: a signed batch that carries a co-signed op carries only co-signed ops of one Account.
  val cosign_alone: bool = st.sub.foldl(true, (ok, x) => ok and or {
    not(x.b.ids.exists(i => isSettle(st, i))),
    and { x.b.ids.forall(i => isSettle(st, i)), x.b.ids.forall(i => acctOf(i) == acctOf(x.b.ids.fold(3, (m, j) => if (j < m) j else m))) }
  })

  val safe: bool = and { urgent_lands, dropped_only_dead, skip_read, failed_read, no_burn, nonce_final, pay_once, urgent_once, nonce_sequential, reserve_sound, dep_never_burns, only_signed_land, cosign_alone }

  // Coverage witnesses (false on purpose: `quint run --invariant` must find a violating trace)
  val w_no_landing: bool = st.gh.landed == 0
  val w_no_revert: bool = st.gh.reverts == 0
  val w_no_failed_batch: bool = st.gh.failed == 0                // a batch failed at its nonce (J5)
  val w_no_drop: bool = not(OPIDS.exists(i => st.dropped.get(i)))
  val w_no_pay: bool = not(OPIDS.exists(i => isMoney(st, i) and st.done.get(i)))
  val w_no_two_landings: bool = st.gh.landed < 2
  val w_no_deposit_landed: bool = not(OPIDS.exists(i => isDep(st, i) and st.done.get(i)))
  val w_no_settlement_failed: bool = not(OPIDS.exists(i => isSettle(st, i) and st.poisoned.get(i) and st.dropped.get(i)))
}
