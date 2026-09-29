// XLN J layer, part two: the Entity's batch to the jurisdiction. Everything the Entity does on chain goes in a batch.
//
// The chain facts (contracts/contracts/Depository.sol processBatch and _processBatch):
//   - a batch is signed for one entity and one nonce and lands only when nonce = stored nonce + 1 (E2 otherwise); landing stores the
//     nonce; a batch that reverts leaves no trace, not even the nonce;
//   - a batch is atomic: one op that reverts (an R2R the reserve cannot cover, a dispute start over a dispute that moved) reverts
//     the whole batch, and a signed batch never expires: anybody can submit it, again, at any later time;
//   - the ops of a batch run in a fixed order (deposits, R2R, C2R, settlements, dispute starts, counters, secret reveals,
//     finalizations, R2C, withdrawals), so one batch can reveal a secret and finalize with it.
//
// What this module answers (QUESTIONS.md J1 to J4):
//   - what a lost, dropped or reverted batch does to the ops and the reserve it held (Q-J1): nothing is lost, and the Entity abandons
//     only ops that can never apply, because a signed batch can land later;
//   - what the fate sharing of one batch and the strict nonce cost the deadline arithmetic of the urgent ops (secret reveals and
//     dispute steps), and which contract behaviour and which Entity packing keep an urgent op inside LAG.
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
  // Entity: how it packs and signs. 0 = one batch of everything queued; 1 = urgent ops first and alone, one batch outstanding;
  // 2 = also replaces an outstanding payment batch at the same nonce; 3 = also signs a follow-up at the next nonce. [J3]
  pure val STRAT = 3

  // ---------------------------------------------------------------------------------------------------------
  // Domain model
  // ---------------------------------------------------------------------------------------------------------

  // Pay: a reserve transfer (reverts when the reserve cannot cover it; runs every time its batch lands). Reveal: a secret goes on the
  // chain (cannot revert). Disp: a dispute start, counter or finalize (reverts when the dispute moved: `poisoned`). Reveal and Disp are
  // urgent; a batch that lands a second time skips an urgent op that already ran.
  type Kind = | Pay | Reveal | Disp
  type Op = { kind: Kind, amt: int, arr: int, dl: int }         // it reaches the Entity at `arr`; on the chain by `dl` (0 = no deadline)
  type Batch = { nonce: int, ids: Set[int] }
  type Sub = { b: Batch, at: int, tried: bool, last: int }       // submitted at `at`; `last` = the tick of its latest attempt

  type Ghost = {
    landed: int,               // batches that landed
    missed: bool,              // an urgent op passed its deadline, still owed and alive
    reverts: int, forks: int
  }

  type S = {
    now: int,
    ops: int -> Op,
    arrived: int -> bool,
    dropped: int -> bool,             // the Entity abandoned the op
    sub: List[Sub],                   // every batch the Entity signed and submitted
    cnonce: int,                      // chain: the stored nonce
    reserve: int,                     // chain: the Entity's reserve
    done: int -> bool,                // chain: the op ran
    runs: int -> int,                 // chain: how many times the op ran
    poisoned: int -> bool,            // chain: the op's dispute moved: it can never apply
    gh: Ghost
  }

  pure val NO_GHOST: Ghost = { landed: 0, missed: false, reverts: 0, forks: 0 }

  var st: S

  // ---------------------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------------------

  pure def isPay(s: S, i: int): bool = match s.ops.get(i).kind { | Pay => true | _ => false }
  pure def isDisp(s: S, i: int): bool = match s.ops.get(i).kind { | Disp => true | _ => false }
  pure def payTotal(s: S, ids: Set[int]): int = ids.fold(0, (m, i) => if (isPay(s, i)) m + s.ops.get(i).amt else m)

  pure def anySub(s: S, f: Sub => bool): bool = s.sub.foldl(false, (a, x) => a or f(x))
  pure def alive(s: S, x: Sub): bool = x.b.nonce > s.cnonce          // its nonce is not used yet: it can still land

  // the Entity's view of an op
  pure def pending(s: S, i: int): bool = s.arrived.get(i) and not(s.done.get(i)) and not(s.dropped.get(i))
  pure def inFlight(s: S, i: int): bool = anySub(s, x => alive(s, x) and x.b.ids.contains(i))

  // ---------------------------------------------------------------------------------------------------------
  // The chain: processBatch
  // ---------------------------------------------------------------------------------------------------------

  pure def applies(s: S, b: Batch): bool = and {
    b.nonce == s.cnonce + 1,
    payTotal(s, b.ids) <= s.reserve,
    TOLERANT or b.ids.forall(i => not(isDisp(s, i) and s.poisoned.get(i)))
  }

  // What running the batch does: a payment runs each time, an urgent op runs once and only if its dispute did not move.
  pure def landOn(s: S, b: Batch): S =
    if (applies(s, b)) {
      val ran = b.ids.filter(i => isPay(s, i) or (not(s.done.get(i)) and not(s.poisoned.get(i))))
      { ...s,
        cnonce: b.nonce,
        reserve: s.reserve - payTotal(s, b.ids),
        done: OPIDS.mapBy(i => s.done.get(i) or ran.contains(i)),
        runs: OPIDS.mapBy(i => s.runs.get(i) + (if (ran.contains(i)) 1 else 0)),
        gh: { ...s.gh, landed: s.gh.landed + 1 } }
    } else { ...s, gh: { ...s.gh, reverts: s.gh.reverts + 1 } }

  // ---------------------------------------------------------------------------------------------------------
  // The Entity: what it signs
  // ---------------------------------------------------------------------------------------------------------

  pure def urgentPending(s: S): Set[int] = OPIDS.filter(i => pending(s, i) and not(isPay(s, i)))
  pure def payQueued(s: S): Set[int] = OPIDS.filter(i => pending(s, i) and isPay(s, i) and not(inFlight(s, i)))

  // a live batch at nonce n that carries every id of `u` and no payment
  pure def coversAt(s: S, n: int, u: Set[int]): bool =
    anySub(s, x => alive(s, x) and x.b.nonce == n and u.subseteq(x.b.ids) and x.b.ids.forall(i => not(isPay(s, i))))

  pure def nothingAlive(s: S): bool = not(anySub(s, x => alive(s, x)))

  // the highest nonce of a live batch that carries no payment (0 = none)
  pure def topUrgentNonce(s: S): int =
    s.sub.foldl(0, (m, x) => if (alive(s, x) and x.b.ids.forall(i => not(isPay(s, i))) and x.b.nonce > m) x.b.nonce else m)

  pure def plan(s: S): List[Batch] = {
    val n = s.cnonce + 1
    val u = urgentPending(s)
    val p = payQueued(s)
    val q = u.union(p)
    if (STRAT == 0) (if (nothingAlive(s) and q.size() > 0) [{ nonce: n, ids: q }] else [])
    else if (u.size() > 0) {
      if (STRAT == 1) (if (nothingAlive(s)) [{ nonce: n, ids: u }] else [])
      else if (STRAT == 2) (if (coversAt(s, n, u)) [] else [{ nonce: n, ids: u }])
      else {
        // Every urgent op that is in no live batch gets a pair of batches of its own, at nonces above every urgent batch already
        // signed (so urgent batches never fork each other, and an old one cannot burn the nonce of a new one). The first of the pair
        // sits at the nonce a live payment batch also holds when there is none above it (a fork the adversary may win, but the
        // second one follows it), the second right behind.
        val fresh = u.filter(i => not(inFlight(s, i)))
        val top = topUrgentNonce(s)
        val base = if (top > 0) top + 1 else n
        if (fresh.size() > 0) [{ nonce: base, ids: fresh }, { nonce: base + 1, ids: fresh }] else []
      }
    }
    else if (nothingAlive(s) and p.size() > 0) [{ nonce: n, ids: p }]
    else []
  }

  pure def submit(s: S, bs: List[Batch]): S =
    { ...s, sub: s.sub.concat(bs.foldl([], (acc, b) => acc.append({ b: b, at: s.now, tried: false, last: 0 }))) }

  pure def react(s: S): S = submit(s, plan(s))

  // ---------------------------------------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------------------------------------

  // scenario tests start from a chosen catalogue
  action initFrom(ops: int -> Op, reserve: int): bool = st' = {
    now: 1, ops: ops,
    arrived: OPIDS.mapBy(_ => false), dropped: OPIDS.mapBy(_ => false), sub: [],
    cnonce: 0, reserve: reserve,
    done: OPIDS.mapBy(_ => false), runs: OPIDS.mapBy(_ => 0), poisoned: OPIDS.mapBy(_ => false),
    gh: NO_GHOST
  }

  action init = {
    nondet a1 = 1.to(2).oneOf()
    nondet a2 = 1.to(3).oneOf()
    nondet a3 = 1.to(3).oneOf()
    nondet a4 = 1.to(3).oneOf()
    nondet m1 = 1.to(2).oneOf()
    nondet m4 = 1.to(2).oneOf()
    st' = {
      now: 1,
      ops: Map(
        1 -> { kind: Pay, amt: m1, arr: a1, dl: 0 },
        2 -> { kind: Reveal, amt: 0, arr: a2, dl: a2 + LAG },
        3 -> { kind: Disp, amt: 0, arr: a3, dl: a3 + LAG },
        4 -> { kind: Pay, amt: m4, arr: a4, dl: 0 }
      ),
      arrived: OPIDS.mapBy(_ => false), dropped: OPIDS.mapBy(_ => false), sub: [],
      cnonce: 0, reserve: RESERVE_MAX,
      done: OPIDS.mapBy(_ => false), runs: OPIDS.mapBy(_ => 0), poisoned: OPIDS.mapBy(_ => false),
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
  // one nonce, and may attempt any batch again. The Entity abandons an op it sees can never apply (its dispute moved) and only that.
  action attempt(j: int): bool = {
    val x = st.sub[j]
    val s1 = landOn(st, x.b)
    val dead = x.b.ids.filter(i => isDisp(st, i) and st.poisoned.get(i))
    all {
      j >= 0, j < st.sub.length(),
      // ascending: every live batch with a lower nonce has been attempted this tick
      not(anySub(st, y => alive(st, y) and y.b.nonce < x.b.nonce and y.last < st.now)),
      st' = react({ ...s1,
        dropped: OPIDS.mapBy(i => st.dropped.get(i) or dead.contains(i)),
        sub: st.sub.foldl([], (acc, y) => acc.append(if (y == x) { ...y, tried: true, last: st.now } else y)) })
    }
  }

  action poison(i: int): bool = all {
    isDisp(st, i), not(st.done.get(i)), not(st.poisoned.get(i)),
    st' = { ...st, poisoned: st.poisoned.set(i, true) }
  }
  action drain(a: int): bool = all { a >= 1, a <= st.reserve, st' = react({ ...st, reserve: st.reserve - a }) }
  action refill(a: int): bool = all { a >= 1, st.reserve + a <= RESERVE_MAX, st' = react({ ...st, reserve: st.reserve + a }) }

  pure def overdue(s: S): bool = anySub(s, x => not(x.tried) and s.now >= x.at + LAG)
  pure def arrivalDue(s: S): bool = OPIDS.exists(i => not(s.arrived.get(i)) and s.ops.get(i).arr <= s.now)
  // an urgent op whose deadline is this tick and is still owed when the clock moves on
  pure def lateNow(s: S): bool = OPIDS.exists(i => and {
    not(isPay(s, i)), s.ops.get(i).dl == s.now, not(s.done.get(i)), not(s.poisoned.get(i))
  })

  action tick: bool = all {
    st.now <= MAXT, not(overdue(st)), not(arrivalDue(st)),
    st' = { ...st, now: st.now + 1, gh: { ...st.gh, missed: st.gh.missed or lateNow(st) } }
  }

  action step = any {
    tick,
    { nondet i = OPIDS.oneOf() arrive(i) },
    arriveDue,
    { nondet j = 0.to(9).oneOf() attempt(j) },
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
  // a payment runs at most once: the signed batch that carries it can land only once per nonce, and the Entity never
  // signs it again while an older batch that carries it can still land.
  val pay_once: bool = OPIDS.forall(i => not(isPay(st, i)) or st.runs.get(i) <= 1)
  // an urgent op runs at most once
  val urgent_once: bool = OPIDS.forall(i => isPay(st, i) or st.runs.get(i) <= 1)
  // the nonce moves by one per landed batch
  val nonce_sequential: bool = st.cnonce == st.gh.landed
  // the reserve is the initial one, less what payments ran, plus what was refilled (checked by payments never overspending)
  val reserve_sound: bool = st.reserve >= 0 and st.reserve <= RESERVE_MAX

  val safe: bool = and { urgent_lands, dropped_only_dead, pay_once, urgent_once, nonce_sequential, reserve_sound }

  // Coverage witnesses (false on purpose: `quint run --invariant` must find a violating trace)
  val w_no_landing: bool = st.gh.landed == 0
  val w_no_revert: bool = st.gh.reverts == 0
  val w_no_fork: bool = not(OPIDS.exists(i => st.done.get(i) and anySub(st, x => not(alive(st, x)) and x.b.ids.contains(i) and x.tried == false)))
  val w_no_drop: bool = not(OPIDS.exists(i => st.dropped.get(i)))
  val w_no_pay: bool = not(OPIDS.exists(i => isPay(st, i) and st.done.get(i)))
  val w_no_two_landings: bool = st.gh.landed < 2
}
