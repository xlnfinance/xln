// XLN Entity layer: what one Entity does with its Accounts when input arrives.
//
// The Entity under test is a hub with two Accounts: IN (peer 1 sends us payments, we are the payee of its locks) and OUT
// (we send them on to peer 2, we are the payer). Both peers are adversaries. The Entity is honest and online: time only
// advances when it has nothing left to do at the current tick (the assumption "processing time < one tick", Q-X2).
//
// What this module owns
//   - One Entity frame as a pure function of the state and one input, in five explicit phases:
//       1 input      a peer's frame arrives, a peer's ack arrives, or a J event is delivered (a refusal never halts)
//       2 hooks      resolve, expire, route (forward or fail back), fail back a dead route, escalate a dispute, reveal
//                    secrets: all read the state AFTER the input, never a snapshot from before it [R-P4]
//       3 command    a signed local command applies to every Account it names, or to none, and spends its nonce only when
//                    it applies [Q-E2]
//       4 propose    one frame per Account with something to say, Accounts in ascending order [R-E4]
//     (a real frame batches several inputs in phase 1; a singleton input keeps the state space small and the ordering of
//     the phases identical, see QUESTIONS.md E1)
//   - The routing rule with its deadline arithmetic: HOP >= 2 * LAG, escalate ESC = LAG before a deadline, fail a route back
//     only once the on-chain window for the onward lock has closed [R-P1, R-P3, R-P4].
//   - The Entity's use of the chain: what a dispute start carries (every known secret that matches a payee lock of the
//     proof) and what a J event does to an Account (it freezes it, always) [flaw 3, #37].
//
// What it does not own: how the two replicas of one Account converge (account.qnt; here an arriving peer frame is one
// transaction that is validated, applied and acked at once, and an ack is one input), what a dispute pays (chain.qnt; the
// interface used here is the contract fact "a clause pays its payee iff the secret is on the chain by the deadline and the
// proof holding the clause is the one the dispute settles"), several tokens, boards, the batch to J (jbatch, later).
//
// The state is one record and the model is checked by simulation only (Apalache needs the state split into variables).
module entity {
  import account_core.* from "./account_core"

  // ---------------------------------------------------------------------------------------------------------
  // Parameters
  // ---------------------------------------------------------------------------------------------------------

  pure val LAG = 1                  // a J transaction is included, and a J event reaches the Entity, within LAG ticks
  pure val HOP = 2                  // the onward lock's deadline is this much earlier than the inbound lock's (2 * LAG)
  pure val ESC = 1                  // a payee escalates when the deadline is at most this far away (>= LAG)
  pure val DWIN = 4                 // a dispute's two response windows together (chain: 2 * MIN_WINDOW); the answer must land inside
  pure val MAXT = 8
  pure val IN = 1
  pure val OUT = 2
  pure val LINKS = [1, 2]          // ascending peer order
  pure val LINKSET = Set(1, 2)
  pure val ORDER = [1, 2]          // route slots, ascending
  pure val ROUTES = Set(1, 2)
  pure val NJ = 4                   // J events in flight
  pure val HALT_ON_REFUSAL = false  // a refused peer frame is a value; it must never stop the Entity [R-X1]

  pure def ours(l: int): Side = if (l == IN) Right else Left
  pure def peerSide(l: int): Side = other(ours(l))

  // The onward lock's deadline: one hop margin earlier than the inbound one.
  pure def outDeadline(dIn: int): int = dIn - HOP

  // ---------------------------------------------------------------------------------------------------------
  // Domain model
  // ---------------------------------------------------------------------------------------------------------

  type Link = {
    tip: Body,                 // the committed state both sides signed
    inflight: List[Tx],        // our frame, sent and not yet acked
    ifTs: int,                 // its timestamp
    mempool: List[Tx],         // queued, not yet proposed
    frozen: bool               // a dispute runs: off-chain frames stop [flaw 3]
  }

  // The route of a payment through the hub, per inbound slot k: the In lock k is forwarded as an Out lock in the lowest free Out slot
  // `os` (E7). Peer 2 may hold Out slots of its own, and another route may hold one, so the slot is not k.
  type RSt =
    | Idle                     // no inbound lock seen
    | Fwd                      // onward lock proposed or live
    | Back                     // failed back: the inbound lock is cancelled or being cancelled
    | Paid                     // the secret was already known: the inbound lock is claimed directly
  type Route = { st: RSt, h: int, dIn: int, dOut: int, os: int }         // os: the Out slot of the onward lock, 0 = none

  // A secret appeared on the chain; the peer's dispute started on a link; our own start landed (DisputeStarted); our own start was
  // skipped because a dispute is already open (DisputeOpSkipped, J2: at most one dispute per Account).
  type JKind = | JSecret(int) | JDispute(int) | JStarted(int) | JSkip(int)
  type JEv = { live: bool, kind: JKind, at: int, seq: int }         // seq: the order the chain emitted it in (the Runtime reads in order)

  // A dispute on a link. `answered`: we have read it and named the proof we stand on (the tip when we read or started).
  // `await`: we sent a start and have not read its outcome (DisputeStarted or DisputeOpSkipped); `pend`: the tick by which our start
  // is on the chain (0 = it is not in flight).
  type Disp = { on: bool, byUs: bool, answered: bool, proof: Body, await: bool, pend: int }

  type Op = { link: int, tx: Tx }
  type Cmd = { nonce: int, ops: List[Op] }

  type Input =
    | Arrive({ link: int, tx: Tx })      // a peer's frame of one transaction
    | AckOf(int)                         // a peer acks our frame on this link
    | JDeliver(int)                      // the Entity reads J event slot i
    | Timer                              // nothing arrived; hooks only
    | Command(Cmd)                       // a signed local command

  type Ghost = {
    halted: bool, refusals: int, drops: int,
    frameOnFrozen: bool, needless: bool, partialCmd: bool, lateAnswer: bool,
    forwards: int, failBacks: int, resolves: int, escalations: int, cmds: int, collisions: int
  }

  type S = {
    now: int,
    links: int -> Link,
    routes: int -> Route,
    known: int -> bool,               // secret id -> the Entity knows it
    nextCmd: int,                     // the command nonce the Entity expects
    chainRev: int -> int,             // secret id -> the time it is on the chain (0 = not)
    jev: int -> JEv,
    disp: int -> Disp,
    cd: int -> int,                   // chain: who holds the open dispute of the link: 0 nobody, 1 us, 2 the peer (at most one)
    jseq: int,                        // chain: events emitted so far
    outcomeRead: int -> bool,         // ghost: we read the outcome of our own start
    outRes: int -> bool,              // ghost, per Out slot: the onward lock was resolved off-chain by peer 2
    inRes: int -> bool,               // ghost: we resolved the inbound lock off-chain
    outCommitted: int -> bool,        // ghost, per Out slot: the onward lock became part of a signed state
    gh: Ghost
  }

  pure val NO_ROUTE: Route = { st: Idle, h: 0, dIn: 0, dOut: 0, os: 0 }
  pure val NO_DISP: Disp = { on: false, byUs: false, answered: false, proof: GENESIS, await: false, pend: 0 }
  pure val NO_JEV: JEv = { live: false, kind: JSecret(0), at: 0, seq: 0 }
  pure val NO_GHOST: Ghost = {
    halted: false, refusals: 0, drops: 0, frameOnFrozen: false, needless: false, partialCmd: false, lateAnswer: false,
    forwards: 0, failBacks: 0, resolves: 0, escalations: 0, cmds: 0, collisions: 0
  }
  pure def emptyLink(tip: Body): Link = { tip: tip, inflight: [], ifTs: 0, mempool: [], frozen: false }

  // Both Accounts start with the whole collateral on Left's side: peer 1 (Left of IN) and we (Left of OUT) can pay 2.
  pure val START_TIP: Body = { ...GENESIS, offdelta: 2 }

  pure val INIT_S: S = {
    now: 1,
    links: Map(IN -> emptyLink(START_TIP), OUT -> emptyLink(START_TIP)),
    routes: ROUTES.mapBy(_ => NO_ROUTE),
    known: SECRETS.mapBy(_ => false),
    nextCmd: 1,
    chainRev: SECRETS.mapBy(_ => 0),
    jev: 1.to(NJ).mapBy(_ => NO_JEV),
    disp: Map(IN -> NO_DISP, OUT -> NO_DISP),
    cd: Map(IN -> 0, OUT -> 0),
    jseq: 0,
    outcomeRead: Map(IN -> false, OUT -> false),
    outRes: ROUTES.mapBy(_ => false),
    inRes: ROUTES.mapBy(_ => false),
    outCommitted: ROUTES.mapBy(_ => false),
    gh: NO_GHOST
  }

  // ---------------------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------------------

  // What we plan against: the committed state, then our frame in flight, then what is queued [Q-E1: one view].
  pure def planOf(lk: Link, me: Side, now: int): Body = {
    val b1 = match replay(lk.tip, lk.inflight, me, lk.ifTs) { | Ok(b) => b | Refused(_) => lk.tip }
    match replay(b1, lk.mempool, me, now) { | Ok(b) => b | Refused(_) => b1 }
  }

  pure def admitsOn(lk: Link, me: Side, now: int, tx: Tx): bool =
    match applyTx(planOf(lk, me, now), tx, me, now) { | Ok(_) => true | Refused(_) => false }

  // A transaction the Entity's own hook wants: it must apply on the planning view and the Account must not be frozen.
  pure def sysOk(s: S, l: int, tx: Tx): bool = {
    val lk = s.links.get(l)
    not(lk.frozen) and admitsOn(lk, ours(l), s.now, tx)
  }

  pure def queueTx(s: S, l: int, tx: Tx): S = {
    val lk = s.links.get(l)
    { ...s, links: s.links.set(l, { ...lk, mempool: lk.mempool.append(tx) }) }
  }

  pure def sysQueue(s: S, l: int, tx: Tx): S = if (sysOk(s, l, tx)) queueTx(s, l, tx) else s

  pure def secretOf(h: int): int = h - 10               // hashOf(secret) = secret + 10
  pure def knowsHash(s: S, h: int): bool =
    if (SECRETS.contains(secretOf(h))) s.known.get(secretOf(h)) else false

  // The on-chain time of a secret counts only if it is there by the deadline.
  pure def chainPaid(s: S, h: int, deadline: int): bool =
    if (SECRETS.contains(secretOf(h))) and { s.chainRev.get(secretOf(h)) != 0, s.chainRev.get(secretOf(h)) <= deadline } else false

  pure def isLockTx(tx: Tx, k: int): bool = match tx { | HtlcLock(x) => x.id == k | _ => false }
  pure def hasLockTx(lk: Link, k: int): bool = lk.inflight.concat(lk.mempool).select(t => isLockTx(t, k)).length() > 0

  // The onward lock of route k: the lock in the route's Out slot, if it is the one we put there for this route.
  pure def outLockOf(s: S, k: int): Lock = {
    val r = s.routes.get(k)
    if (r.os == 0) NO_LOCK
    else {
      val l = s.links.get(OUT).tip.locks.get(r.os)
      if (l.on and l.payer == ours(OUT) and l.hashlock == r.h) l else NO_LOCK
    }
  }

  // E7: the Out slot a new route takes: the lowest one that is free on the planning view (committed, in flight and queued) and that no
  // route that is not over holds. 0 when there is none.
  pure def reservedOut(s: S, j: int): bool = ROUTES.exists(k => s.routes.get(k).os == j)
  pure def freeOutSlot(s: S): int = {
    val plan = planOf(s.links.get(OUT), ours(OUT), s.now)
    ORDER.foldl(0, (m, j) => if (m == 0 and not(plan.locks.get(j).on) and not(reservedOut(s, j))) j else m)
  }

  // ---------------------------------------------------------------------------------------------------------
  // Phase 1: input
  // ---------------------------------------------------------------------------------------------------------

  // A committed resolve teaches us its secret; a resolved onward lock is a payment made.
  pure def learn(s: S, l: int, tx: Tx): S = match tx {
    | HtlcResolve(r) => {
        val s1 = { ...s, known: s.known.set(r.secret, true) }
        if (l == OUT) { ...s1, outRes: s1.outRes.set(r.id, true) } else s1
      }
    | _ => s
  }

  // A committed frame of ours: remember what became part of a signed state.
  pure def noteCommitted(s: S, l: int, tx: Tx): S = match tx {
    | HtlcResolve(r) => if (l == IN) { ...s, inRes: s.inRes.set(r.id, true) } else s
    | HtlcLock(x) => if (l == OUT) { ...s, outCommitted: s.outCommitted.set(x.id, true) } else s
    | _ => s
  }

  // The peer's frame. Collision with our own frame in flight: the Left side's frame stands [R-A1].
  pure def arrive(s: S, l: int, tx: Tx): S = {
    val lk = s.links.get(l)
    val me = ours(l)
    if (lk.frozen) s
    else if (lk.inflight.length() > 0 and me == Left) { ...s, gh: { ...s.gh, collisions: s.gh.collisions + 1 } }
    else {
      val rolled = lk.inflight.length() > 0
      val lk1 = if (rolled) { ...lk, mempool: lk.inflight.concat(lk.mempool), inflight: [] } else lk
      val s0 = { ...s, links: s.links.set(l, lk1), gh: { ...s.gh, collisions: s.gh.collisions + (if (rolled) 1 else 0) } }
      match applyTx(lk1.tip, tx, other(me), s.now) {
        | Ok(b) => learn({ ...s0, links: s0.links.set(l, { ...lk1, tip: b }) }, l, tx)
        | Refused(_) => { ...s0, gh: { ...s0.gh, refusals: s0.gh.refusals + 1, halted: s0.gh.halted or HALT_ON_REFUSAL } }
      }
    }
  }

  // The peer acked our frame: it becomes committed.
  pure def ackOf(s: S, l: int): S = {
    val lk = s.links.get(l)
    if (lk.frozen or lk.inflight.length() == 0) s
    else match replay(lk.tip, lk.inflight, ours(l), lk.ifTs) {
      | Ok(b) => {
          val s1 = lk.inflight.foldl(s, (acc, tx) => noteCommitted(acc, l, tx))
          { ...s1, links: s1.links.set(l, { ...lk, tip: b, inflight: [] }) }
        }
      | Refused(_) => { ...s, links: s.links.set(l, { ...lk, inflight: [] }), gh: { ...s.gh, drops: s.gh.drops + 1 } }
    }
  }

  // A dispute on a link stops the off-chain life of that Account, whoever started it.
  pure def freeze(s: S, l: int): S = {
    val lk = s.links.get(l)
    { ...s, links: s.links.set(l, { ...lk, frozen: true, inflight: [], mempool: [] }) }
  }

  // Put on the chain every known secret that opens a payee clause of the proof we stand on, once. [R-P3, #37]
  pure def publishFor(s: S, l: int): S = {
    val d = s.disp.get(l)
    ORDER.foldl(s, (acc, k) => {
      val lock = d.proof.locks.get(k)
      if (d.answered and lock.on and payee(lock) == ours(l) and knowsHash(acc, lock.hashlock) and acc.chainRev.get(secretOf(lock.hashlock)) == 0)
        { ...acc, chainRev: acc.chainRev.set(secretOf(lock.hashlock), acc.now + LAG) }
      else acc
    })
  }

  // We have read a dispute: the proof we stand on is our tip, and the secrets go out with it.
  pure def answer(s: S, l: int): S = {
    val d = s.disp.get(l)
    publishFor({ ...s, disp: s.disp.set(l, { ...d, on: true, answered: true, proof: s.links.get(l).tip }) }, l)
  }

  // We read the outcome of our own start. It landed (DisputeStarted): nothing more to wait for. It was skipped (DisputeOpSkipped):
  // a dispute is already open and it is not ours, so the wait is over and we answer the open one with our tip and every known secret
  // (the DisputeStarted of the open dispute comes first in chain order; answering again is the same answer).
  pure def onSkip(s: S, l: int): S = {
    val s1 = answer(freeze(s, l), l)
    val d = s1.disp.get(l)
    { ...s1, disp: s1.disp.set(l, { ...d, byUs: false, await: false }) }
  }

  pure def outcome(s: S, l: int, skipped: bool): S = {
    val s1 = if (skipped) onSkip(s, l) else { ...s, disp: s.disp.set(l, { ...s.disp.get(l), await: false }) }
    { ...s1, outcomeRead: s1.outcomeRead.set(l, true) }
  }

  pure def jdeliver(s: S, i: int): S = {
    val ev = s.jev.get(i)
    if (not(ev.live) or ev.at > s.now) s
    else {
      val s1 = { ...s, jev: s.jev.set(i, { ...ev, live: false }) }
      match ev.kind {
        | JSecret(sec) => { ...s1, known: s1.known.set(sec, true) }
        | JDispute(l) => {
          val s2 = answer(freeze(s1, l), l)
          // the dispute is on the chain since ev.at; our counter lands LAG after we read it and must beat the timeout (C11)
          { ...s2, gh: { ...s2.gh, lateAnswer: s2.gh.lateAnswer or s.now + LAG >= ev.at + DWIN } }
        }
        | JStarted(l) => outcome(s1, l, false)
        | JSkip(l) => outcome(s1, l, true)
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Phase 2: hooks (all read the state after the input)
  // ---------------------------------------------------------------------------------------------------------

  // Resolve: the payee of a live lock knows its secret and the deadline has not passed.
  pure def resolveOne(s: S, l: int, k: int): S = {
    val lock = s.links.get(l).tip.locks.get(k)
    if (lock.on and payee(lock) == ours(l) and knowsHash(s, lock.hashlock) and s.now <= lock.deadline) {
      val tx = HtlcResolve({ id: k, secret: secretOf(lock.hashlock) })
      if (sysOk(s, l, tx)) { ...queueTx(s, l, tx), gh: { ...s.gh, resolves: s.gh.resolves + 1 } } else s
    } else s
  }

  // Expire: anyone may remove a lock whose deadline has passed.
  pure def expireOne(s: S, l: int, k: int): S = {
    val lock = s.links.get(l).tip.locks.get(k)
    if (lock.on and s.now > lock.deadline) sysQueue(s, l, HtlcExpire({ id: k })) else s
  }

  // Route: a new inbound lock is forwarded with the deadline margin, or failed back in this same frame [R-P1].
  pure def routeOne(s: S, k: int): S = {
    val lk = s.links.get(IN)
    val lock = lk.tip.locks.get(k)
    val r = s.routes.get(k)
    if (lk.frozen or not(lock.on) or payee(lock) != ours(IN) or r.st != Idle) s
    else if (knowsHash(s, lock.hashlock))
      { ...s, routes: s.routes.set(k, { st: Paid, h: lock.hashlock, dIn: lock.deadline, dOut: 0, os: 0 }) }
    else {
      val dOut = outDeadline(lock.deadline)
      val os = freeOutSlot(s)
      val fw = HtlcLock({ id: os, payer: ours(OUT), amount: lock.amount, hashlock: lock.hashlock, deadline: dOut })
      if (os != 0 and sysOk(s, OUT, fw))
        { ...queueTx(s, OUT, fw),
          routes: s.routes.set(k, { st: Fwd, h: lock.hashlock, dIn: lock.deadline, dOut: dOut, os: os }),
          outRes: s.outRes.set(os, false), outCommitted: s.outCommitted.set(os, false),
          gh: { ...s.gh, forwards: s.gh.forwards + 1 } }
      else
        { ...sysQueue(s, IN, HtlcCancel({ id: k })), routes: s.routes.set(k, { st: Back, h: lock.hashlock, dIn: lock.deadline, dOut: 0, os: 0 }),
          gh: { ...s.gh, failBacks: s.gh.failBacks + 1 } }
    }
  }

  // Fail a forwarded route back once the onward lock is dead for sure: gone from a signed state, or past its deadline
  // plus the time a reveal on the chain takes to reach us. Never while we know the secret (that is a claim, not a failure).
  pure def failBackOne(s: S, k: int): S = {
    val r = s.routes.get(k)
    if (r.st != Fwd) s
    else {
      val outLock = outLockOf(s, k)
      val outDead = or { and { s.outCommitted.get(r.os), not(outLock.on) }, s.now > r.dOut + LAG }
      if (knowsHash(s, r.h) or not(outDead)) s
      else { ...sysQueue(s, IN, HtlcCancel({ id: k })), routes: s.routes.set(k, { ...r, st: Back }),
             gh: { ...s.gh, failBacks: s.gh.failBacks + 1 } }
    }
  }

  // Escalate: some payee lock of this link has a known secret and its deadline is near.
  pure def escalates(view: int -> Link, s: S, l: int): bool =
    ORDER.foldl(false, (acc, k) => {
      val lock = view.get(l).tip.locks.get(k)
      or { acc, and { lock.on, payee(lock) == ours(l), knowsHash(s, lock.hashlock), s.now + ESC >= lock.deadline, s.now <= lock.deadline } }
    })

  pure def startOwn(s: S, l: int): S = {
    val s1 = freeze(s, l)
    val s2 = { ...s1,
               disp: s1.disp.set(l, { on: true, byUs: true, answered: true, proof: s.links.get(l).tip, await: true, pend: s.now + LAG }),
               gh: { ...s1.gh, escalations: s1.gh.escalations + 1, needless: s1.gh.needless or not(escalates(s.links, s, l)) } }
    publishFor(s2, l)
  }

  pure def escalateOne(view: int -> Link, s: S, l: int): S =
    if (not(s.links.get(l).frozen) and not(s.disp.get(l).on) and escalates(view, s, l)) startOwn(s, l) else s

  // A dispute already running: any secret we learn later still goes out.
  pure def revealOne(s: S, l: int): S = publishFor(s, l)

  // Both locks gone, nothing queued for the slot: the route is over and the slot can be used again.
  pure def resetOne(s: S, k: int): S = {
    val r = s.routes.get(k)
    val inGone = not(s.links.get(IN).tip.locks.get(k).on)
    val outGone = and { not(outLockOf(s, k).on), not(hasLockTx(s.links.get(OUT), r.os)) }
    if (r.st != Idle and inGone and outGone) {
      val s1 = { ...s, routes: s.routes.set(k, NO_ROUTE), inRes: s.inRes.set(k, false) }
      if (r.os == 0) s1 else { ...s1, outRes: s1.outRes.set(r.os, false), outCommitted: s1.outCommitted.set(r.os, false) }
    } else s
  }

  pure def perLink(s: S, f: (S, int) => S): S = LINKS.foldl(s, (acc, l) => f(acc, l))
  pure def perSlot(s: S, f: (S, int) => S): S = ORDER.foldl(s, (acc, k) => f(acc, k))

  // The hooks, in this order, on the state after the input. `view` is what the escalation reads.
  pure def hooks(s: S, view: int -> Link): S = {
    val a = LINKS.foldl(s, (acc, l) => ORDER.foldl(acc, (a2, k) => resolveOne(a2, l, k)))
    val b = LINKS.foldl(a, (acc, l) => ORDER.foldl(acc, (a2, k) => expireOne(a2, l, k)))
    val c = perSlot(b, routeOne)
    val d = perSlot(c, failBackOne)
    val e = LINKS.foldl(d, (acc, l) => escalateOne(view, acc, l))
    val f = LINKS.foldl(e, (acc, l) => revealOne(acc, l))
    perSlot(f, resetOne)
  }

  // ---------------------------------------------------------------------------------------------------------
  // Phase 3: local command (all or nothing, nonce spent only on apply) [Q-E2]
  // ---------------------------------------------------------------------------------------------------------

  pure def applyCmd(s: S, c: Cmd): S =
    if (c.nonce != s.nextCmd) s
    else {
      val r = c.ops.foldl({ ok: true, ls: s.links }, (acc, op) => {
        val lk = acc.ls.get(op.link)
        if (not(acc.ok)) acc
        else if (lk.frozen or lk.mempool.length() >= MAX_MEMPOOL or not(admitsOn(lk, ours(op.link), s.now, op.tx))) { ok: false, ls: acc.ls }
        else { ok: true, ls: acc.ls.set(op.link, { ...lk, mempool: lk.mempool.append(op.tx) }) }
      })
      val out = if (r.ok) { ...s, links: r.ls, nextCmd: s.nextCmd + 1, gh: { ...s.gh, cmds: s.gh.cmds + 1 } } else s
      { ...out, gh: { ...out.gh, partialCmd: out.gh.partialCmd or (out.links != s.links and out.nextCmd == s.nextCmd) } }
    }

  // ---------------------------------------------------------------------------------------------------------
  // Phase 4: propose, one frame per Account, ascending
  // ---------------------------------------------------------------------------------------------------------

  pure def proposeOn(s: S, l: int): S = {
    val lk = s.links.get(l)
    if (lk.frozen or lk.inflight.length() > 0 or lk.mempool.length() == 0) s
    else {
      val sel = keepValid(lk.tip, lk.mempool, ours(l), s.now)
      val dropped = lk.mempool.length() - sel.txs.length()
      { ...s, links: s.links.set(l, { ...lk, inflight: sel.txs, ifTs: s.now, mempool: [] }),
        gh: { ...s.gh, drops: s.gh.drops + dropped,
              frameOnFrozen: s.gh.frameOnFrozen or (lk.frozen and sel.txs.length() > 0) } }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // One Entity frame
  // ---------------------------------------------------------------------------------------------------------

  // Phase 1 for one input.
  pure def applyInput(s: S, inp: Input): S = match inp {
    | Arrive(a) => arrive(s, a.link, a.tx)
    | AckOf(l) => ackOf(s, l)
    | JDeliver(i) => jdeliver(s, i)
    | _ => s
  }

  // The inputs of one frame, in the Runtime's canonical order (runtime.qnt R1): the peers' frames and acks, then chain events, then
  // commands. `frameOf` takes them as given; a frame carries at most one command.
  pure def rankOf(inp: Input): int = match inp {
    | Arrive(_) => 0
    | AckOf(_) => 0
    | JDeliver(_) => 1
    | Command(_) => 2
    | Timer => 3
  }

  pure def frameOf(s0: S, inps: List[Input]): S = {
    val s1 = inps.foldl(s0, (acc, inp) => applyInput(acc, inp))
    val s2 = hooks(s1, s1.links)
    val s3 = inps.foldl(s2, (acc, inp) => match inp { | Command(c) => applyCmd(acc, c) | _ => acc })
    LINKS.foldl(s3, (acc, l) => proposeOn(acc, l))
  }

  pure def frame(s0: S, inp: Input): S = frameOf(s0, [inp])

  // ---------------------------------------------------------------------------------------------------------
  // State and actions: the environment is the two peers and the chain
  // ---------------------------------------------------------------------------------------------------------

  var st: S

  action init = st' = INIT_S

  action feed(inp: Input): bool = all { st.now <= MAXT, st' = frame(st, inp) }

  // Nothing is left to do at this tick, and no J event has waited longer than LAG.
  pure def quiescent(s: S): bool = frame(s, Timer) == s
  pure def overdue(s: S): bool = 1.to(NJ).exists(i => s.jev.get(i).live and s.jev.get(i).at + LAG <= s.now)
  // a start of ours that was sent is on the chain by `pend`: time does not move past it
  pure def startOverdue(s: S): bool = LINKSET.exists(l => s.disp.get(l).pend > 0 and s.disp.get(l).pend <= s.now)

  action tick: bool = all { st.now < MAXT, quiescent(st), not(overdue(st)), st' = { ...st, now: st.now + 1 } }
  // in a run, time also waits for our start to land; scripted tests move the clock as they like
  action tickWaitingForStart: bool = all { not(startOverdue(st)), tick }

  action timer: bool = feed(Timer)

  // Two inputs in one frame (E1): any two of the peers' frames, acks and chain events, in canonical order.
  pure def someInput(kind: int, l: int, k: int, sec: int, off: int, amt: int, i: int, now: int): Input =
    if (kind == 0) Arrive({ link: IN, tx: HtlcLock({ id: k, payer: peerSide(IN), amount: amt, hashlock: hashOf(sec), deadline: now + off }) })
    else if (kind == 1) Arrive({ link: OUT, tx: HtlcResolve({ id: k, secret: sec }) })
    else if (kind == 2) Arrive({ link: OUT, tx: HtlcCancel({ id: k }) })
    else if (kind == 3) AckOf(l)
    else JDeliver(i)

  action feedTwo: bool = {
    nondet k1 = 0.to(4).oneOf()
    nondet k2 = 0.to(4).oneOf()
    nondet l = LINKSET.oneOf()
    nondet k = ROUTES.oneOf()
    nondet sec = SECRETS.oneOf()
    nondet off = 1.to(LOCK_SLACK).oneOf()
    nondet amt = 1.to(2).oneOf()
    nondet i = 1.to(NJ).oneOf()
    val a = someInput(k1, l, k, sec, off, amt, i, st.now)
    val b = someInput(k2, l, k, sec, off, amt, i, st.now)
    val pair = if (rankOf(a) <= rankOf(b)) [a, b] else [b, a]
    all { st.now <= MAXT, st' = frameOf(st, pair) }
  }

  // Peer 1 offers a lock on IN: any slot, any secret (it knows them all), any deadline the Account accepts.
  action peerLock(k: int, sec: int, off: int, amt: int): bool =
    feed(Arrive({ link: IN, tx: HtlcLock({ id: k, payer: peerSide(IN), amount: amt, hashlock: hashOf(sec), deadline: st.now + off }) }))
  action peerLockIn: bool = {
    nondet k = ROUTES.oneOf()
    nondet sec = SECRETS.oneOf()
    nondet off = 1.to(LOCK_SLACK).oneOf()
    nondet amt = 1.to(2).oneOf()
    peerLock(k, sec, off, amt)
  }

  // Peer 2 claims an onward lock off-chain, or gives it up.
  action peerResolve(k: int, sec: int): bool = feed(Arrive({ link: OUT, tx: HtlcResolve({ id: k, secret: sec }) }))
  action peerCancel(k: int): bool = feed(Arrive({ link: OUT, tx: HtlcCancel({ id: k }) }))
  action peerResolveOut: bool = { nondet k = ROUTES.oneOf() nondet sec = SECRETS.oneOf() peerResolve(k, sec) }
  action peerCancelOut: bool = { nondet k = ROUTES.oneOf() peerCancel(k) }

  // A peer's arbitrary frame of any kind: refusals are behaviour too.
  action peerAny(l: int): bool = {
    nondet kind = 0.to(5).oneOf()
    nondet n = 0.to(MAX_AMOUNT).oneOf()
    nondet id = ROUTES.oneOf()
    nondet sec = SECRETS.oneOf()
    nondet off = 1.to(LOCK_SLACK).oneOf()
    feed(Arrive({ link: l, tx: mkTx(kind, peerSide(l), n, id, sec, off, st.now) }))
  }

  action peerAck(l: int): bool = feed(AckOf(l))

  // The chain: a peer reveals a secret on it, or starts a dispute on a link. Each becomes an event we read within LAG.
  pure def freeJ(s: S): int = 1.to(NJ).fold(0, (m, i) => if (m == 0 and not(s.jev.get(i).live)) i else m)

  // the chain emits an event into a free slot; we read it within LAG, in the order it was emitted
  pure def emitJ(s: S, i: int, kind: JKind): S =
    { ...s, jseq: s.jseq + 1, jev: s.jev.set(i, { live: true, kind: kind, at: s.now + LAG, seq: s.jseq + 1 }) }

  action peerReveal(sec: int): bool = {
    val i = freeJ(st)
    all {
      i != 0, st.chainRev.get(sec) == 0,
      st' = emitJ({ ...st, chainRev: st.chainRev.set(sec, st.now + LAG) }, i, JSecret(sec))
    }
  }
  action peerRevealChain: bool = { nondet sec = SECRETS.oneOf() peerReveal(sec) }

  action peerStartsDispute(l: int): bool = {
    val i = freeJ(st)
    all {
      i != 0, not(st.disp.get(l).on),
      st' = emitJ({ ...st, disp: st.disp.set(l, { ...NO_DISP, on: true }), cd: st.cd.set(l, 2) }, i, JDispute(l))
    }
  }

  // The peer's start reaches the chain before ours does: a dispute is open when our start (sent at the same time) is included.
  action peerStartsBeside(l: int): bool = {
    val i = freeJ(st)
    val d = st.disp.get(l)
    all {
      i != 0, d.on, d.byUs, d.pend > 0, st.now <= d.pend, st.cd.get(l) == 0,
      st' = emitJ({ ...st, cd: st.cd.set(l, 2) }, i, JDispute(l))
    }
  }

  // Our start is included. With no dispute open it opens ours (DisputeStarted); with one open it is skipped (DisputeOpSkipped).
  action ownStartLands(l: int): bool = {
    val i = freeJ(st)
    val d = st.disp.get(l)
    all {
      i != 0, d.on, d.byUs, d.pend > 0, st.now <= d.pend,
      st' = emitJ({ ...st, disp: st.disp.set(l, { ...d, pend: 0 }), cd: st.cd.set(l, if (st.cd.get(l) == 0) 1 else st.cd.get(l)) },
                  i, if (st.cd.get(l) == 0) JStarted(l) else JSkip(l))
    }
  }

  action deliver(i: int): bool = feed(JDeliver(i))
  // The Runtime reads chain events in the order the chain emitted them (runtime.qnt R-J1).
  pure def nextJ(s: S, i: int): bool = and {
    s.jev.get(i).live,
    1.to(NJ).forall(j => not(s.jev.get(j).live) or s.jev.get(j).seq >= s.jev.get(i).seq)
  }
  action deliverJ: bool = { nondet i = 1.to(NJ).oneOf() all { nextJ(st, i), deliver(i) } }

  // Local commands: a payment on one Account, or one on each (a batch that must apply as a whole).
  action cmd(nonce: int, ops: List[Op]): bool = feed(Command({ nonce: nonce, ops: ops }))
  action cmdPay: bool = {
    nondet l = Set(IN, OUT).oneOf()
    nondet n = 1.to(2).oneOf()
    nondet off = (-1).to(1).oneOf()
    feed(Command({ nonce: st.nextCmd + off, ops: [{ link: l, tx: Pay({ from: ours(l), amount: n }) }] }))
  }
  action cmdBatch: bool = {
    nondet n1 = 1.to(2).oneOf()
    nondet n2 = 1.to(2).oneOf()
    feed(Command({ nonce: st.nextCmd, ops: [{ link: IN, tx: Pay({ from: ours(IN), amount: n1 }) }, { link: OUT, tx: Pay({ from: ours(OUT), amount: n2 }) }] }))
  }

  action step = any {
    tickWaitingForStart, timer, feedTwo,
    peerLockIn, peerLockIn, peerResolveOut, peerCancelOut,
    peerAny(IN), peerAny(OUT),
    peerAck(IN), peerAck(OUT),
    peerRevealChain, peerStartsDispute(IN), peerStartsDispute(OUT),
    peerStartsBeside(IN), peerStartsBeside(OUT), ownStartLands(IN), ownStartLands(OUT),
    deliverJ, deliverJ,
    cmdPay, cmdBatch
  }

  // ---------------------------------------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------------------------------------

  // R-X1: nothing a peer sends stops the Entity.
  val no_peer_halt: bool = not(st.gh.halted)

  // R-P1: an inbound lock that we are the payee of is never left without a route: it is forwarded or failed back in the
  // frame that made it committed (unless a dispute froze the Account).
  val no_stranded: bool = ROUTES.forall(k => {
    val lk = st.links.get(IN)
    val lock = lk.tip.locks.get(k)
    or { lk.frozen, not(lock.on), payee(lock) != ours(IN), st.routes.get(k).st != Idle }
  })

  // R-P2: the onward lock expires at least HOP before the inbound one.
  val deadline_chain: bool = ROUTES.forall(k => {
    val r = st.routes.get(k)
    val outLock = outLockOf(st, k)
    or { r.st != Fwd, and { r.dOut + HOP <= r.dIn, not(outLock.on) or outLock.deadline + HOP <= r.dIn } }
  })

  // R-P3: in a dispute, every known secret that opens a payee clause of the proof is on the chain.
  val dispute_carries_all: bool = LINKSET.forall(l => {
    val d = st.disp.get(l)
    or { not(d.on and d.answered),
         ROUTES.forall(k => {
           val lock = d.proof.locks.get(k)
           or { not(lock.on), payee(lock) != ours(l), not(knowsHash(st, lock.hashlock)), st.chainRev.get(secretOf(lock.hashlock)) != 0 }
         }) }
  })

  // R-P4: the Entity never opens a dispute over a lock that this frame's input already resolved.
  val no_needless_dispute: bool = not(st.gh.needless)

  // C11: the Entity's answer to a dispute lands before the windows close: read within LAG, included within LAG, and the two windows
  // together are longer than that.
  val answer_in_window: bool = not(st.gh.lateAnswer)

  // J2: the outcome of our own start is read from the chain and ends the wait, skipped or not. A skipped start leaves the open
  // dispute (the peer's) answered, and it is not ours any more.
  val skip_ends_the_wait: bool = LINKSET.forall(l => {
    val d = st.disp.get(l)
    or { not(st.outcomeRead.get(l)), and { not(d.await), d.answered } }
  })

  // Flaw 3: a frozen Account never gets a frame from us.
  val no_frame_on_frozen: bool = not(st.gh.frameOnFrozen)

  // Q-E2: a command that does not apply changes nothing, and costs no nonce.
  val cmd_atomic: bool = not(st.gh.partialCmd)

  // P2: credit holds on every committed state and on the state we plan against.
  val credit_holds: bool = LINKSET.forall(l => {
    val lk = st.links.get(l)
    and { rcpan(lk.tip), rcpan(planOf(lk, ours(l), st.now)) }
  })

  // P5: the hub is never out of pocket. Once an inbound deadline has passed, if the onward lock was paid, then the inbound lock
  // was claimed too. Paid onward means: peer 2 resolved it off-chain, or a dispute on OUT holds a proof with our lock and the
  // secret was on the chain by the onward deadline (a secret on the chain pays nobody by itself). Claimed inbound means: we
  // resolved it off-chain, or a dispute on IN holds a proof with the lock and the secret was on the chain by the inbound deadline.
  val route_safe: bool = ROUTES.forall(k => {
    val r = st.routes.get(k)
    val dIn = st.disp.get(IN)
    val dOut = st.disp.get(OUT)
    val outProofLock = if (r.os == 0) NO_LOCK else dOut.proof.locks.get(r.os)
    val outHeld = and { dOut.on, dOut.answered, outProofLock.on, outProofLock.payer == ours(OUT), outProofLock.hashlock == r.h }
    val paidOut = r.os != 0 and st.outCommitted.get(r.os) and (st.outRes.get(r.os) or (outHeld and chainPaid(st, r.h, r.dOut)))
    val claimedIn = st.inRes.get(k) or (dIn.on and dIn.proof.locks.get(k).on and chainPaid(st, r.h, r.dIn))
    not(r.st != Idle and st.now > r.dIn and paidOut and not(claimedIn))
  })

  val safe: bool = and {
    no_peer_halt, no_stranded, deadline_chain, dispute_carries_all, no_needless_dispute,
    no_frame_on_frozen, cmd_atomic, credit_holds, route_safe, answer_in_window, skip_ends_the_wait
  }

  // Coverage witnesses: each is false on purpose; `quint run --invariant` must find a violating trace.
  val w_no_forward: bool = st.gh.forwards == 0
  val w_no_failback: bool = st.gh.failBacks == 0
  val w_no_resolve: bool = st.gh.resolves == 0
  val w_no_escalation: bool = st.gh.escalations == 0
  val w_no_refusal: bool = st.gh.refusals == 0
  val w_no_command: bool = st.gh.cmds == 0
  val w_no_collision: bool = st.gh.collisions == 0
  val w_no_frozen: bool = not(LINKSET.exists(l => st.links.get(l).frozen))
  val w_no_out_paid: bool = not(ROUTES.exists(k => st.outRes.get(k)))
  val w_no_chain_reveal: bool = not(SECRETS.exists(sec => st.chainRev.get(sec) != 0))
  val w_no_outcome: bool = not(LINKSET.exists(l => st.outcomeRead.get(l)))
  val w_no_in_claim: bool = not(ROUTES.exists(k => st.inRes.get(k)))
}
