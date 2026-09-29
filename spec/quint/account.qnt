// XLN Account layer: two parties, one token, one shared ledger, the signed-frame protocol between them.
//
// What this module owns
//   - Body: the state both parties agree on at one height (offdelta, credit limits, open HTLC clauses).
//   - Tx: the closed table of Account transitions and the refusal each one can give.
//   - The frame protocol: propose, receive, ack, collision (Left wins), rollback, resend, drop, duplicate.
//   - Signed proofs: every proof a party signs is recorded, so properties can talk about what the chain
//     could be shown (design/account-model.md section 2: the chain reads only proofs).
//
// What it does not own (other modules): the chain and disputes (chain.qnt), the Entity frame that decides when an
// Account frame is proposed or acked (entity.qnt), and cooperative settlement (settle.qnt).
//
// Reading guide: each rule cites its source as [R-..]/[Q-..] (plan/lessons.md), [C1..H3] (plan/contracts-review.md),
// or "designed" when no source fixes it. Every choice made between options is written down in QUESTIONS.md.
//
// Encoding style (house rule for every module here, so Apalache can check it):
//   - collections with a small fixed key set are maps over that set (locks by slot, history by height,
//     signatures by (signer, nonce, branch)), never sets of records;
//   - a nondeterministic tx is built from small independent picks, never drawn from a big set of variants;
//   - the state is a handful of separate variables, never one big record (the model checker's input has a size cap).

module account {
  // ---------------------------------------------------------------------------------------------------------
  // Parameters. Small on purpose: Apalache explores every value in these ranges.
  // ---------------------------------------------------------------------------------------------------------

  pure val COLLATERAL = 2        // agreed on-chain collateral; ondelta is 0 here (chain moves arrive with settle.qnt)
  pure val MAX_AMOUNT = 3        // one payment or lock is between 1 and MAX_AMOUNT
  pure val MAX_CREDIT = 3        // a credit limit is between 0 and MAX_CREDIT
  pure val MAX_HEIGHT = 3        // frames per run; bounds the search
  pure val MAX_FRAMES = 6        // frame arena size: every proposal, including the ones rolled back
  pure val MAX_MEMPOOL = 2
  pure val MAX_CLOCK = 4         // logical seconds
  pure val DRIFT = 1             // the two clocks never differ by more than this (assumption, QUESTIONS.md Q-X2)
  pure val TOLERANCE = 1         // a receiver refuses a frame whose timestamp is further than this from its own clock
  pure val LOCK_SLACK = 2        // a lock's deadline is at most this far after the frame that opens it
  pure val LOCK_SLOTS = Set(1, 2) // open clauses per Account (the contract's bound is 32, see contracts-review.md)
  pure val SECRETS = Set(1, 2)   // the secrets that exist; a hashlock is hashOf(secret)

  // ---------------------------------------------------------------------------------------------------------
  // Domain model
  // ---------------------------------------------------------------------------------------------------------

  type Side = | Left | Right

  pure def other(s: Side): Side = match s { | Left => Right | Right => Left }

  // A conditional clause in slot `id`: `payer` owes `amount` to the other side if the preimage of `hashlock` is shown
  // before `deadline`. Mirrors DeltaTransformer.Payment{deltaIndex, amount, revealedUntilTimestamp, hash}.
  // A free slot is NO_LOCK, always the same value, so equal bodies are equal values.
  type Lock = { on: bool, payer: Side, amount: int, hashlock: int, deadline: int }

  // What both parties hold at one height.
  //   offdelta    Left's allocation beyond the on-chain ondelta. Left paying makes it smaller, Right paying larger.
  //   limitLeft   how far Left may owe (credit Right extends to Left). limitRight: the mirror.
  //   locks       the open clauses by slot.
  type Body = { offdelta: int, limitLeft: int, limitRight: int, locks: int -> Lock }

  // The part of a Body that the chain reads: Types.sol ProofBody minus the fixed windows and watchSeed.
  // Credit limits are NOT in it: the chain never sees them (Depository.sol:949-956).
  type Proof = { offdelta: int, locks: int -> Lock }

  type Tx =
    | SetCredit({ by: Side, limit: int })                       // `by` extends `limit` of credit to the other side
    | Pay({ from: Side, amount: int })
    | HtlcLock({ id: int, payer: Side, amount: int, hashlock: int, deadline: int })
    | HtlcResolve({ id: int, secret: int })                     // the payee shows the preimage
    | HtlcCancel({ id: int })                                   // the payee gives the lock up (htlc_resolve outcome error)
    | HtlcExpire({ id: int })                                   // anyone, after the deadline

  // `prev` (the hash of the parent frame on the wire) is left out: a receiver replays `txs` on its own tip and compares
  // with `after`, which catches every fork a parent hash would (QUESTIONS.md Q-A6).
  type Frame = { height: int, ts: int, author: Side, txs: List[Tx], after: Body }

  // Frames live in one arena and are named by their id, the way the wire names them by hash. A message is a frame id:
  // a proposal goes to the author's peer, an ack goes to the author.
  type Status =
    | Open
    | Proposed(int)        // frame id: we sent it and wait for the ack
    | Received(int)        // frame id: we validated the peer's frame and hold it until our own ack

  // A signature over a dispute proof is named by (signer, nonce, authorIsLeft); authorIsLeft is part of the signed
  // hash on chain (HankoEncoding.sol:36, vectors/README.md "dispute proof"). The signature covers the proof of
  // the frame it was made for, so it is stored as that frame's id (0 = no signature).
  type SigKey = (Side, int, bool)

  type Replica = {
    height: int,
    tip: Body,                 // the last committed body
    lastTs: int,
    lastFid: int,              // the last committed frame (0 = none), kept to answer a repeated propose with the same ack
    status: Status,
    mempool: List[Tx]
  }

  type Res = | Ok(Body) | Refused(str)

  // ---------------------------------------------------------------------------------------------------------
  // Derived views (pure functions of a Body)
  // ---------------------------------------------------------------------------------------------------------

  pure def hashOf(secret: int): int = secret + 10          // stands for keccak256 of a preimage

  pure def imax(a: int, b: int): int = if (a > b) a else b
  pure def imin(a: int, b: int): int = if (a < b) a else b

  pure def delta(b: Body): int = b.offdelta                // ondelta = 0 in this module

  pure def holds(b: Body, s: Side): int =
    LOCK_SLOTS.fold(0, (acc, i) => acc + (if (b.locks.get(i).on and b.locks.get(i).payer == s) b.locks.get(i).amount else 0))

  pure def lockCount(b: Body): int = LOCK_SLOTS.fold(0, (acc, i) => acc + (if (b.locks.get(i).on) 1 else 0))

  // What a side can still pay: its share plus the credit the other side extends, minus what its clauses hold.
  // xln.ts leftCanPay / rightCanPay / outCapacity (4594-4597), which follow Depository.sol's payout rule.
  pure def room(b: Body, s: Side): int = match s {
    | Left => imax(0, delta(b) + b.limitLeft - holds(b, Left))
    | Right => imax(0, COLLATERAL + b.limitRight - delta(b) - holds(b, Right))
  }

  // RCPAN [R-A6]: the allocation stays inside [-limitLeft, COLLATERAL + limitRight], in the worst case over the
  // outcomes of every open clause. Worst case low: every Left-payer clause resolves. Worst case high: every
  // Right-payer clause resolves. The two extremes cover every subset.
  pure def rcpan(b: Body): bool = and {
    delta(b) >= -b.limitLeft,
    delta(b) <= COLLATERAL + b.limitRight,
    delta(b) - holds(b, Left) >= -b.limitLeft,
    delta(b) + holds(b, Right) <= COLLATERAL + b.limitRight
  }

  pure def proofOf(b: Body): Proof = { offdelta: b.offdelta, locks: b.locks }

  pure val NO_LOCK: Lock = { on: false, payer: Left, amount: 0, hashlock: 0, deadline: 0 }
  pure val GENESIS: Body =
    { offdelta: 0, limitLeft: 0, limitRight: 0, locks: LOCK_SLOTS.mapBy(_ => NO_LOCK) }

  pure def payee(l: Lock): Side = other(l.payer)

  // ---------------------------------------------------------------------------------------------------------
  // The transition table. `author` proposes the frame, `ts` is the frame's timestamp.
  // Every refusal is a value: nothing here can halt a Runtime [R-X1].
  // ---------------------------------------------------------------------------------------------------------

  pure def withLock(b: Body, id: int, l: Lock): Body = { ...b, locks: b.locks.set(id, l) }

  pure def applyTx(b: Body, tx: Tx, author: Side, ts: int): Res = match tx {
    | Pay(p) =>
        if (p.from != author) Refused("not_own_funds")
        else if (p.amount < 1 or p.amount > MAX_AMOUNT) Refused("bad_amount")
        else if (p.amount > room(b, p.from)) Refused("insufficient_capacity")
        else match p.from {
          | Left => Ok({ ...b, offdelta: b.offdelta - p.amount })
          | Right => Ok({ ...b, offdelta: b.offdelta + p.amount })
        }
    | SetCredit(c) =>
        if (c.by != author) Refused("not_own_credit")
        else if (c.limit < 0 or c.limit > MAX_CREDIT) Refused("bad_credit")
        else {
          val nb = match c.by {
            | Right => { ...b, limitLeft: c.limit }
            | Left => { ...b, limitRight: c.limit }
          }
          // lowering a limit below what is already used would break RCPAN at the current allocation
          if (rcpan(nb)) Ok(nb) else Refused("credit_below_usage")
        }
    | HtlcLock(l) =>
        if (not(LOCK_SLOTS.contains(l.id))) Refused("bad_slot")
        else if (l.payer != author) Refused("not_own_funds")
        else if (l.amount < 1 or l.amount > MAX_AMOUNT) Refused("bad_amount")
        else if (b.locks.get(l.id).on) Refused("lock_exists")
        else if (l.deadline <= ts) Refused("deadline_past")
        else if (l.deadline > ts + LOCK_SLACK) Refused("deadline_too_far")
        else if (l.amount > room(b, l.payer)) Refused("insufficient_capacity")
        else Ok(withLock(b, l.id, { on: true, payer: l.payer, amount: l.amount, hashlock: l.hashlock, deadline: l.deadline }))
    | HtlcResolve(r) =>
        if (not(LOCK_SLOTS.contains(r.id))) Refused("bad_slot")
        else if (not(b.locks.get(r.id).on)) Refused("no_such_lock")
        else {
          val l = b.locks.get(r.id)
          if (payee(l) != author) Refused("not_payee")
          else if (hashOf(r.secret) != l.hashlock) Refused("wrong_secret")
          else if (ts > l.deadline) Refused("past_deadline")
          else {
            val moved = match l.payer {
              | Left => b.offdelta - l.amount
              | Right => b.offdelta + l.amount
            }
            Ok({ ...withLock(b, r.id, NO_LOCK), offdelta: moved })
          }
        }
    | HtlcCancel(r) =>
        if (not(LOCK_SLOTS.contains(r.id))) Refused("bad_slot")
        else if (not(b.locks.get(r.id).on)) Refused("no_such_lock")
        else if (payee(b.locks.get(r.id)) != author) Refused("not_payee")
        else Ok(withLock(b, r.id, NO_LOCK))
    | HtlcExpire(r) =>
        if (not(LOCK_SLOTS.contains(r.id))) Refused("bad_slot")
        else if (not(b.locks.get(r.id).on)) Refused("no_such_lock")
        else if (ts <= b.locks.get(r.id).deadline) Refused("not_expired")
        else Ok(withLock(b, r.id, NO_LOCK))
  }

  // A frame is all-or-nothing on the receiving side: the first refused tx refuses the frame [Q-E2, R-X1].
  pure def replay(b: Body, txs: List[Tx], author: Side, ts: int): Res =
    txs.foldl(Ok(b), (acc, tx) => match acc {
      | Ok(cur) => applyTx(cur, tx, author, ts)
      | Refused(why) => Refused(why)
    })

  // The proposer keeps only the txs that still apply, in order. A tx that no longer applies is dropped, not halted on.
  pure def keepValid(b: Body, txs: List[Tx], author: Side, ts: int): { body: Body, txs: List[Tx] } =
    txs.foldl({ body: b, txs: List() }, (acc, tx) => match applyTx(acc.body, tx, author, ts) {
      | Ok(nx) => { body: nx, txs: acc.txs.append(tx) }
      | Refused(_) => acc
    })

  // A tx built from small independent picks. Every combination is tried, valid or not: refusals are behaviour too.
  //   kind 0 Pay, 1 SetCredit, 2 HtlcLock, 3 HtlcResolve, 4 HtlcCancel, 5 HtlcExpire.
  pure def mkTx(kind: int, side: Side, n: int, id: int, secret: int, dlOffset: int, ts: int): Tx =
    if (kind == 0) Pay({ from: side, amount: n })
    else if (kind == 1) SetCredit({ by: side, limit: n })
    else if (kind == 2) HtlcLock({ id: id, payer: side, amount: n, hashlock: hashOf(secret), deadline: ts + dlOffset })
    else if (kind == 3) HtlcResolve({ id: id, secret: secret })
    else if (kind == 4) HtlcCancel({ id: id })
    else HtlcExpire({ id: id })

  // ---------------------------------------------------------------------------------------------------------
  // Replica transitions (pure)
  // ---------------------------------------------------------------------------------------------------------

  pure val SIDES = Set(Left, Right)
  pure val BRANCHES = Set(true, false)
  pure val NO_FRAME: Frame = { height: 0, ts: 0, author: Left, txs: List(), after: GENESIS }

  pure val EMPTY_REPLICA: Replica =
    { height: 0, tip: GENESIS, lastTs: 0, lastFid: 0, status: Open, mempool: List() }

  // The state a side must plan against: the committed one, or the frame in flight / held [Q-E1: one view].
  pure def planning(r: Replica, frames: int -> Frame): Body = match r.status {
    | Open => r.tip
    | Proposed(fid) => frames.get(fid).after
    | Received(fid) => frames.get(fid).after
  }

  pure def isOpen(r: Replica): bool = match r.status { | Open => true | _ => false }
  pure def isReceived(r: Replica): bool = match r.status { | Received(_) => true | _ => false }
  pure def isProposed(r: Replica): bool = match r.status { | Proposed(_) => true | _ => false }
  pure def statusFid(r: Replica): int = match r.status { | Open => 0 | Proposed(f) => f | Received(f) => f }

  // A frame the receiver accepts: the next height, on time, and replaying on its own tip to the claimed state.
  pure def acceptable(r: Replica, now: int, f: Frame, self: Side): bool = and {
    f.author != self,
    f.height == r.height + 1,
    f.ts >= r.lastTs,
    f.ts <= now + TOLERANCE,
    f.ts + TOLERANCE >= now,
    match replay(r.tip, f.txs, f.author, f.ts) {
      | Ok(b) => b == f.after
      | Refused(_) => false
    }
  }

  // Queue a local tx. The guard sees the planning state plus everything already queued [Q-E1]: a tx that could never
  // apply is refused here and never enters the mempool.
  pure def admits(r: Replica, plan: Body, now: int, s: Side, tx: Tx): bool = and {
    r.mempool.length() < MAX_MEMPOOL,
    match replay(plan, r.mempool, s, now) {
      | Ok(b) => match applyTx(b, tx, s, now) { | Ok(_) => true | Refused(_) => false }
      | Refused(_) => false
    }
  }

  // The frame a proposer would send now: its mempool cut down to the txs that still apply, on its tip.
  pure def frameToPropose(r: Replica, now: int, s: Side): Frame = {
    val sel = keepValid(r.tip, r.mempool, s, now)
    { height: r.height + 1, ts: now, author: s, txs: sel.txs, after: sel.body }
  }

  pure def canPropose(r: Replica, now: int, s: Side): bool = and {
    isOpen(r),
    r.height < MAX_HEIGHT,
    now >= r.lastTs,
    frameToPropose(r, now, s).txs.length() > 0
  }

  pure def sigKey(signer: Side, f: Frame): SigKey = (signer, f.height, f.author == Left)

  // What a receiver does with a Propose. In order:
  //   1. it extends our tip and we are Open -> hold it for our ack.
  //   2. it is the frame we last committed (our ack was lost) -> send the same ack again (idempotent).
  //   3. we also proposed at this height (collision): Left keeps its frame and ignores Right's;
  //      Right discards its own frame, puts its txs back in the mempool, and takes Left's [R-A1].
  //   4. anything else is stale, from the future, or refused: dropped and counted.
  type Outcome = { r: Replica, ack: bool, rolled: bool, refused: bool }

  pure def onPropose(r: Replica, now: int, s: Side, fid: int, f: Frame, own: Frame): Outcome = {
    val keep: Outcome = { r: r, ack: false, rolled: false, refused: false }
    val refuse: Outcome = { ...keep, refused: true }
    match r.status {
      | Open =>
          if (acceptable(r, now, f, s)) { ...keep, r: { ...r, status: Received(fid) } }
          else if (r.lastFid == fid) { ...keep, ack: true }
          else refuse
      | Received(held) => if (held == fid) keep else refuse
      | Proposed(_) =>
          if (f.height == own.height and f.author != s) {
            match s {
              | Left => keep
              | Right => {
                  val restored = { ...r, status: Open, mempool: own.txs.concat(r.mempool) }
                  if (acceptable(restored, now, f, s)) { ...keep, r: { ...restored, status: Received(fid) }, rolled: true }
                  else refuse
                }
            }
          } else refuse
    }
  }

  // Commit frame `f` (id `fid`) on a replica.
  pure def commit(r: Replica, fid: int, f: Frame): Replica =
    { ...r, height: f.height, tip: f.after, lastTs: f.ts, lastFid: fid, status: Open }

  // ---------------------------------------------------------------------------------------------------------
  // State and actions
  // ---------------------------------------------------------------------------------------------------------

  var replica: Side -> Replica
  var frames: int -> Frame           // arena of every frame ever proposed, by id
  var nextFid: int
  var proposals: Set[int]            // frame ids in flight to the author's peer; delivery does not consume, so any can repeat
  var acks: Set[int]                 // frame ids acked, in flight to the author
  var signed: SigKey -> int          // the frame each (signer, nonce, branch) signature was made for; 0 = none
  var clock: Side -> int
  var firstCommit: int -> int        // ghost: per height, the frame the first side to commit it committed
  var diverged: bool                 // ghost: the two sides committed different bodies at one height
  var equivocated: bool              // ghost: a signer was about to sign a second, different proof for one key
  var rollbacks: int                 // ghost: Right proposals rolled back on collision
  var refusals: int                  // ghost: peer frames refused

  // Sign frame `fid`'s proof under `k`. A second, different proof under the same key is the equivocation P4b forbids.
  pure def clashes(sg: SigKey -> int, frames: int -> Frame, k: SigKey, f: Frame): bool =
    sg.get(k) != 0 and proofOf(frames.get(sg.get(k)).after) != proofOf(f.after)

  action init = all {
    replica' = SIDES.mapBy(_ => EMPTY_REPLICA),
    frames' = 0.to(MAX_FRAMES).mapBy(_ => NO_FRAME),
    nextFid' = 1,
    proposals' = Set(), acks' = Set(),
    signed' = tuples(SIDES, 0.to(MAX_HEIGHT), BRANCHES).mapBy(_ => 0),
    clock' = SIDES.mapBy(_ => 0),
    firstCommit' = 0.to(MAX_HEIGHT).mapBy(_ => 0),
    diverged' = false, equivocated' = false, rollbacks' = 0, refusals' = 0
  }

  // Time passes on one side's clock. The two clocks may not drift apart by more than DRIFT (assumption).
  action tick(s: Side): bool = all {
    clock.get(s) < MAX_CLOCK,
    clock.get(s) + 1 - clock.get(other(s)) <= DRIFT,
    clock' = clock.set(s, clock.get(s) + 1),
    replica' = replica, frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed,
    firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
    rollbacks' = rollbacks, refusals' = refusals
  }

  // Queue `tx` on side `s`. Scripted form, so tests can drive exact scenarios; `enqueue` below tries every tx.
  action enqueueTx(s: Side, tx: Tx): bool = {
    val r = replica.get(s)
    all {
      admits(r, planning(r, frames), clock.get(s), s, tx),
      replica' = replica.set(s, { ...r, mempool: r.mempool.append(tx) }),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed,
      clock' = clock, firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
      rollbacks' = rollbacks, refusals' = refusals
    }
  }

  action enqueue(s: Side): bool = {
    nondet kind = 0.to(5).oneOf()
    nondet side = SIDES.oneOf()
    nondet n = 0.to(MAX_AMOUNT).oneOf()
    nondet id = LOCK_SLOTS.oneOf()
    nondet secret = SECRETS.oneOf()
    nondet dl = 1.to(LOCK_SLACK).oneOf()
    enqueueTx(s, mkTx(kind, side, n, id, secret, dl, clock.get(s)))
  }

  // The proposer freezes its mempool into one frame at the next height, signs the frame and the resulting proof,
  // and sends it. One frame in flight per Account.
  action propose(s: Side): bool = {
    val r = replica.get(s)
    val f = frameToPropose(r, clock.get(s), s)
    all {
      canPropose(r, clock.get(s), s),
      nextFid <= MAX_FRAMES,
      replica' = replica.set(s, { ...r, status: Proposed(nextFid), mempool: List() }),
      frames' = frames.set(nextFid, f),
      nextFid' = nextFid + 1,
      proposals' = proposals.union(Set(nextFid)),
      signed' = signed.set(sigKey(s, f), nextFid),
      equivocated' = (equivocated or clashes(signed, frames, sigKey(s, f), f)),
      acks' = acks, clock' = clock, firstCommit' = firstCommit, diverged' = diverged,
      rollbacks' = rollbacks, refusals' = refusals
    }
  }

  // Re-send the frame in flight. Safe because a receiver treats a repeated frame as the same frame.
  action resend(s: Side): bool = {
    val r = replica.get(s)
    all {
      isProposed(r),
      proposals' = proposals.union(Set(statusFid(r))),
      replica' = replica, frames' = frames, nextFid' = nextFid, acks' = acks, signed' = signed,
      clock' = clock, firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
      rollbacks' = rollbacks, refusals' = refusals
    }
  }

  // Deliver frame `fid`'s proposal to side `s`. Scripted form; `receiveProposal` picks any frame in flight.
  action deliverProposal(s: Side, fid: int): bool = {
    val r = replica.get(s)
    val f = frames.get(fid)
    val o = onPropose(r, clock.get(s), s, fid, f, frames.get(statusFid(r)))
    all {
      proposals.contains(fid),
      f.author != s,
      replica' = replica.set(s, o.r),
      acks' = if (o.ack) acks.union(Set(fid)) else acks,
      rollbacks' = if (o.rolled) rollbacks + 1 else rollbacks,
      refusals' = if (o.refused) refusals + 1 else refusals,
      frames' = frames, nextFid' = nextFid, proposals' = proposals, signed' = signed, clock' = clock,
      firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated
    }
  }

  action receiveProposal(s: Side): bool = {
    nondet fid = proposals.filter(i => frames.get(i).author != s).oneOf()
    deliverProposal(s, fid)
  }

  // Ghost bookkeeping for agreement: the first commit at a height is remembered, the second must match it.
  pure def mismatch(fc: int -> int, frames: int -> Frame, f: Frame): bool =
    fc.get(f.height) != 0 and frames.get(fc.get(f.height)).after != f.after

  // The receiver, holding a validated frame, signs the frame and the resulting proof, commits, and answers.
  // At the Entity layer this is the moment its consensus certifies the ack (entity.qnt).
  action ackReceived(s: Side): bool = {
    val r = replica.get(s)
    val fid = statusFid(r)
    val f = frames.get(fid)
    all {
      isReceived(r),
      replica' = replica.set(s, commit(r, fid, f)),
      signed' = signed.set(sigKey(s, f), fid),
      equivocated' = (equivocated or clashes(signed, frames, sigKey(s, f), f)),
      firstCommit' = if (firstCommit.get(f.height) == 0) firstCommit.set(f.height, fid) else firstCommit,
      diverged' = (diverged or mismatch(firstCommit, frames, f)),
      acks' = acks.union(Set(fid)),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, clock' = clock,
      rollbacks' = rollbacks, refusals' = refusals
    }
  }

  // The proposer receives the ack for frame `fid`. It commits only if the ack names the frame it has in flight; the
  // ack carries the acker's signature, which must exist.
  action deliverAck(s: Side, fid: int): bool = {
    val r = replica.get(s)
    val f = frames.get(fid)
    val peer = signed.get(sigKey(other(s), f))
    val fits = and { isProposed(r), statusFid(r) == fid, peer != 0, proofOf(frames.get(peer).after) == proofOf(f.after) }
    all {
      acks.contains(fid),
      f.author == s,
      replica' = if (fits) replica.set(s, commit(r, fid, f)) else replica,
      firstCommit' = if (fits and firstCommit.get(f.height) == 0) firstCommit.set(f.height, fid) else firstCommit,
      diverged' = (diverged or (fits and mismatch(firstCommit, frames, f))),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed,
      clock' = clock, equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals
    }
  }

  action receiveAck(s: Side): bool = {
    nondet fid = acks.filter(i => frames.get(i).author == s).oneOf()
    deliverAck(s, fid)
  }

  // The network loses a message. Scripted forms name the message; `dropProposal` / `dropAck` lose any one.
  action loseProposal(fid: int): bool = all {
    proposals.contains(fid),
    proposals' = proposals.exclude(Set(fid)),
    replica' = replica, frames' = frames, nextFid' = nextFid, acks' = acks, signed' = signed,
    clock' = clock, firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
    rollbacks' = rollbacks, refusals' = refusals
  }
  action loseAck(fid: int): bool = all {
    acks.contains(fid),
    acks' = acks.exclude(Set(fid)),
    replica' = replica, frames' = frames, nextFid' = nextFid, proposals' = proposals, signed' = signed,
    clock' = clock, firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
    rollbacks' = rollbacks, refusals' = refusals
  }
  action dropProposal: bool = { nondet fid = proposals.oneOf() loseProposal(fid) }
  action dropAck: bool = { nondet fid = acks.oneOf() loseAck(fid) }

  action step = any {
    tick(Left), tick(Right),
    enqueue(Left), enqueue(Right),
    propose(Left), propose(Right),
    resend(Left), resend(Right),
    receiveProposal(Left), receiveProposal(Right),
    ackReceived(Left), ackReceived(Right),
    receiveAck(Left), receiveAck(Right),
    dropProposal, dropAck
  }

  // ---------------------------------------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------------------------------------

  // P2 credit holds: every committed state, and every state a side holds in flight, satisfies RCPAN.
  // (Every committed body was once in flight, so checking the tip and the planning state checks them all.)
  val credit_holds: bool = SIDES.forall(s => {
    val r = replica.get(s)
    rcpan(r.tip) and rcpan(planning(r, frames))
  })

  // P4a agreed: the two sides never committed different bodies at one height.
  val agreed: bool = not(diverged)

  // P4b no equivocation: a signer never signs two different proofs for one (nonce, branch author).
  val no_equivocation: bool = not(equivocated)

  // P4c both sign the same proof: for the head of each side's history, both signatures over the proof of the body it
  // committed exist, on the branch that authored it.
  val both_signed: bool = SIDES.forall(s => {
    val r = replica.get(s)
    if (r.lastFid == 0) r.height == 0
    else {
      val f = frames.get(r.lastFid)
      and {
        f.height == r.height,
        f.after == r.tip,
        signed.get(sigKey(s, f)) != 0,
        signed.get(sigKey(other(s), f)) != 0,
        proofOf(frames.get(signed.get(sigKey(s, f))).after) == proofOf(r.tip),
        proofOf(frames.get(signed.get(sigKey(other(s), f))).after) == proofOf(r.tip)
      }
    }
  })

  val safe: bool = and { credit_holds, agreed, no_equivocation, both_signed }

  // Coverage witnesses: each is false on purpose, and `quint run --invariant` must find a violating trace.
  // A witness that cannot be violated means the path it names is unreachable in this model.
  val w_no_commit: bool = replica.get(Left).height == 0
  val w_no_two_commits: bool = replica.get(Right).height < 2
  val w_no_rollback: bool = rollbacks == 0
  val w_no_refusal: bool = refusals == 0
  val w_no_lock: bool = lockCount(replica.get(Left).tip) == 0
  val w_no_paid: bool = replica.get(Left).tip.offdelta == 0
}
