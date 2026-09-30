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
  import account_core.* from "./account_core"
  export account_core.*

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
  var byz: int                       // 0 both sides honest; 1 Left is Byzantine, 2 Right is (chosen once, at any moment): the honest side is checked, the Byzantine one only sends
  var badCommit: bool                // ghost: a committed frame did what its author may not (see `badEffect`, `expiredEarly`)
  var badAccept: bool                // ghost: a replica held a frame for its ack that a correct receiver must have refused (see `wellFormed`)

  // Sign frame `fid`'s proof under `k`. A second, different proof under the same key is the equivocation P4b forbids.
  pure def clashes(sg: SigKey -> int, frames: int -> Frame, k: SigKey, f: Frame): bool =
    sg.get(k) != 0 and proofOf(frames.get(sg.get(k)).after) != proofOf(f.after)

  // What a frame may do to the ledger, stated on the effect and not on the guards that are meant to enforce it (P2, authority).
  // What a side has of its own to pay: its allocation less what its open clauses hold, credit left out (credit is the other side's to grant).
  pure def own(b: Body, s: Side): int = match s {
    | Left => b.offdelta - holds(b, Left)
    | Right => COLLATERAL - b.offdelta - holds(b, Right)
  }
  pure def creditFor(b: Body, s: Side): int = match s { | Left => b.limitLeft | Right => b.limitRight }
  // An author never lowers what the other side has of its own to pay (no spending, locking or resolving the other side's funds),
  // and never changes the credit it receives (no granting itself credit). It may lower the credit it extends.
  pure def badEffect(before: Body, f: Frame): bool = or {
    own(f.after, other(f.author)) < own(before, other(f.author)),
    creditFor(f.after, f.author) != creditFor(before, f.author)
  }
  // No committed expiry while either clock is at or before the deadline: the payee, on its own clock, may still resolve [R-CLOCK, F2 of the first review].
  // The guard adds the reserve to the deciding side's clock; with the clocks within DRIFT that leaves the other side's clock past the deadline. The oracle states the goal, not the guard.
  pure def expiredEarly(before: Body, f: Frame, ck: Side -> int): bool = f.txs.foldl(false, (acc, tx) => acc or match tx {
    | HtlcExpire(r) => and { before.locks.get(r.id).on, imin(ck.get(Left), ck.get(Right)) <= before.locks.get(r.id).deadline }
    | _ => false
  })
  pure def badCommitOf(before: Body, f: Frame, ck: Side -> int): bool = badEffect(before, f) or expiredEarly(before, f, ck)

  def isByz(s: Side): bool = byz == (match s { | Left => 1 | Right => 2 })

  action init = all {
    replica' = SIDES.mapBy(_ => EMPTY_REPLICA),
    frames' = 0.to(MAX_FRAMES).mapBy(_ => NO_FRAME),
    nextFid' = 1,
    proposals' = Set(), acks' = Set(),
    signed' = tuples(SIDES, 0.to(MAX_NONCE), BRANCHES).mapBy(_ => 0),
    clock' = SIDES.mapBy(_ => 0),
    firstCommit' = 0.to(MAX_HEIGHT).mapBy(_ => 0),
    diverged' = false, equivocated' = false, rollbacks' = 0, refusals' = 0, badAccept' = false, badCommit' = false, byz' = 0
  }

  // Time passes on one side's clock. The two clocks may not drift apart by more than DRIFT (assumption).
  action tick(s: Side): bool = all {
    clock.get(s) < MAX_CLOCK,
    clock.get(s) + 1 - clock.get(other(s)) <= DRIFT,
    clock' = clock.set(s, clock.get(s) + 1),
    replica' = replica, frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed,
    firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
    rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
  }

  // Queue `tx` on side `s`. Scripted form, so tests can drive exact scenarios; `enqueue` below tries every tx.
  action enqueueTx(s: Side, tx: Tx): bool = {
    val r = replica.get(s)
    all {
      not(isByz(s)),
      admits(r, planning(r, frames), clock.get(s), s, tx),
      replica' = replica.set(s, { ...r, mempool: r.mempool.append(tx) }),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed,
      clock' = clock, firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
      rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  action enqueue(s: Side): bool = {
    nondet kind = 0.to(5).oneOf()
    nondet side = SIDES.oneOf()
    nondet n = 0.to(MAX_AMOUNT).oneOf()
    nondet id = LOCK_SLOTS.oneOf()
    nondet secret = SECRETS.oneOf()
    nondet dl = 1.to(MAX_LOCK_HORIZON).oneOf()
    enqueueTx(s, mkTx(kind, side, n, id, secret, dl, clock.get(s)))
  }

  // The proposer freezes its mempool into one frame at the next height, signs the frame and the resulting proof,
  // and sends it. One frame in flight per Account.
  action propose(s: Side): bool = {
    val r = replica.get(s)
    nondet gap = 0.to(MAX_NONCE_GAP).oneOf()
    val f = frameToPropose(r, clock.get(s), s, gap)
    all {
      not(isByz(s)),
      canPropose(r, clock.get(s), s),
      nextFid <= MAX_FRAMES,
      replica' = replica.set(s, { ...r, status: Proposed(nextFid), mempool: List() }),
      frames' = frames.set(nextFid, f),
      nextFid' = nextFid + 1,
      proposals' = proposals.union(Set(nextFid)),
      signed' = signed.set(sigKey(s, f), nextFid),
      equivocated' = (equivocated or clashes(signed, frames, sigKey(s, f), f)),
      acks' = acks, clock' = clock, firstCommit' = firstCommit, diverged' = diverged,
      rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  // Re-send the frame in flight. Safe because a receiver treats a repeated frame as the same frame.
  action resend(s: Side): bool = {
    val r = replica.get(s)
    all {
      not(isByz(s)),
      isProposed(r),
      proposals' = proposals.union(Set(statusFid(r))),
      replica' = replica, frames' = frames, nextFid' = nextFid, acks' = acks, signed' = signed,
      clock' = clock, firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
      rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  // Deliver frame `fid`'s proposal to side `s`. Scripted form; `receiveProposal` picks any frame in flight.
  action deliverProposal(s: Side, fid: int): bool = {
    val r = replica.get(s)
    val f = frames.get(fid)
    val o = onPropose(r, clock.get(s), s, fid, f, frames.get(statusFid(r)))
    all {
      not(isByz(s)),
      proposals.contains(fid),
      f.author != s,
      replica' = replica.set(s, o.r),
      acks' = if (o.ack) acks.union(Set(fid)) else acks,
      rollbacks' = if (o.rolled) rollbacks + 1 else rollbacks,
      refusals' = if (o.refused) refusals + 1 else refusals,
      badAccept' = (badAccept or (heldNow(r, o.r, fid) and not(wellFormed(r, clock.get(s), f)))), badCommit' = badCommit, byz' = byz,
      frames' = frames, nextFid' = nextFid, proposals' = proposals, signed' = signed, clock' = clock,
      firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated
    }
  }

  pure def secretOfHash(h: int): int = h - 10        // the adversary knows every secret: the inverse of hashOf

  // What a correct receiver must have checked before it holds a frame for its ack, stated again here on purpose (the mechanism is
  // `acceptable` in account_core): the next height, and a claimed state equal to the replay of the frame's txs on its tip at its OWN
  // clock. The frame's timestamp is not part of it [R-CLOCK]. A frame that fails and is still held is a bug.
  pure def wellFormed(r: Replica, now: int, f: Frame): bool = {
    val replays = match replay(r.tip, f.txs, f.author, now) { | Ok(b) => b == f.after | Refused(_) => false }
    and { f.height == r.height + 1, f.nonce > r.pnonce, f.nonce <= r.pnonce + 1 + MAX_NONCE_GAP, replays }
  }
  pure def heldNow(before: Replica, after: Replica, fid: int): bool =
    isReceived(after) and statusFid(after) == fid and not(isReceived(before) and statusFid(before) == fid)

  // A Byzantine proposer (the author's key is in the adversary's hands): it sends the honest side a frame that no correct proposer
  // would send, built on the receiver's exact tip and clock so that the only fault is the one named. The Byzantine author's signature is
  // implied (it signs anything, and may sign two frames for one key), so `signed` is not touched. The honest side signs only what it
  // accepts, and every one of these is refused now (one that later fits its height is a frame like any other).
  //   0 a claimed state that is not the replay of the txs   1 a skipped height
  //   4 a proof nonce that is not above the last committed one   5 a proof nonce that leaps more than MAX_NONCE_GAP (N1)
  //   2 an expiry of an open lock, stamped far in the future, before the receiver's own clock is past the deadline and the reserve
  //   3 a resolve of an open lock with its secret, stamped in the past, after the receiver's own clock has passed the deadline
  // (Old and future stamps on frames that are otherwise correct are accepted, by R-CLOCK: `oldFrameIsAcceptedAfterAnOutageTest`.)
  action byzPropose(a: Side, kind: int, id: int): bool = {
    val rcv = other(a)
    val r = replica.get(rcv)
    val now = clock.get(rcv)
    val lock = r.tip.locks.get(id)
    val gone = { ...r.tip, locks: r.tip.locks.set(id, NO_LOCK) }
    val f: Frame =
      if (kind == 0) { height: r.height + 1, nonce: r.pnonce + 1, ts: now, author: a, txs: List(), after: { ...r.tip, offdelta: r.tip.offdelta + 1 } }
      else if (kind == 1) { height: r.height + 2, nonce: r.pnonce + 1, ts: now, author: a, txs: List(), after: r.tip }
      else if (kind == 2) { height: r.height + 1, nonce: r.pnonce + 1, ts: now + 100, author: a, txs: [HtlcExpire({ id: id })], after: gone }
      else if (kind == 3) { height: r.height + 1, nonce: r.pnonce + 1, ts: 0, author: a, txs: [HtlcResolve({ id: id, secret: secretOfHash(lock.hashlock) })],
             after: { ...gone, offdelta: if (lock.payer == Left) r.tip.offdelta - lock.amount else r.tip.offdelta + lock.amount } }
      else if (kind == 4) { height: r.height + 1, nonce: r.pnonce, ts: now, author: a, txs: List(), after: r.tip }                            // N1: a proof nonce that is not above the last
      else { height: r.height + 1, nonce: r.pnonce + 2 + MAX_NONCE_GAP, ts: now, author: a, txs: List(), after: r.tip }                       // N1: a leap
    all {
      isByz(a), r.height < MAX_HEIGHT,          // the search bound: a frame above MAX_HEIGHT is outside the signature map
      kind >= 0, kind <= 5,
      LOCK_SLOTS.contains(id),
      if (kind == 2 or kind == 3) and { lock.on, if (kind == 2) now <= lock.deadline + CLOCK_RESERVE else and { now > lock.deadline, payee(lock) == a } } else true,
      nextFid <= MAX_FRAMES,
      frames' = frames.set(nextFid, f),
      nextFid' = nextFid + 1,
      proposals' = proposals.union(Set(nextFid)),
      replica' = replica, acks' = acks, signed' = signed, clock' = clock, firstCommit' = firstCommit, diverged' = diverged,
      equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  // One side turns Byzantine (its key is taken) at any moment; from then on only the other side is honest and only it is checked.
  action turnByzantine(a: Side): bool = all {
    byz == 0,
    byz' = (match a { | Left => 1 | Right => 2 }),
    replica' = replica, frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed, clock' = clock,
    firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals,
    badAccept' = badAccept, badCommit' = badCommit
  }

  // A Byzantine frame that is correct except for its stamp: the next height, the empty replay, signed by its author. The stamp is
  // 0 or far ahead of every clock. Accepted (R-CLOCK), so it is committed like any other frame and both sides hold both signatures.
  action byzStamped(a: Side, future: bool): bool = {
    val rcv = other(a)
    val r = replica.get(rcv)
    val f: Frame = { height: r.height + 1, nonce: r.pnonce + 1, ts: if (future) clock.get(rcv) + 100 else 0, author: a, txs: List(), after: r.tip }
    all {
      isByz(a), r.height < MAX_HEIGHT, nextFid <= MAX_FRAMES,
      frames' = frames.set(nextFid, f),
      nextFid' = nextFid + 1,
      proposals' = proposals.union(Set(nextFid)),
      signed' = signed,
      replica' = replica, acks' = acks, clock' = clock, firstCommit' = firstCommit, diverged' = diverged,
      equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  // The same, carrying what the author has queued: the frame its own replica would propose, with the stamp far ahead of every clock. It is a
  // valid replay, so the receiver commits it; only the stamp is odd. (Used by a scenario test, not by the step: byzPropose already draws stamps.)
  action byzStampedQueued(a: Side): bool = {
    val rcv = other(a)
    val f: Frame = { ...frameToPropose(replica.get(a), clock.get(a), a, 0), ts: clock.get(rcv) + 100 }
    all {
      isByz(a), f.txs.length() > 0, f.height <= MAX_HEIGHT, nextFid <= MAX_FRAMES,
      frames' = frames.set(nextFid, f),
      nextFid' = nextFid + 1,
      proposals' = proposals.union(Set(nextFid)),
      signed' = signed,
      replica' = replica, acks' = acks, clock' = clock, firstCommit' = firstCommit, diverged' = diverged,
      equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  // The Byzantine side answers the honest side's frame in flight with an ack. Correct: it signs the proof of the frame. Otherwise it
  // signs a different proof for the same (nonce, branch) and the honest side must not commit on it.
  action byzAck(a: Side, correct: bool): bool = {
    val hon = other(a)
    val r = replica.get(hon)
    val fid = statusFid(r)
    val f = frames.get(fid)
    val other_ = { ...f, after: { ...f.after, offdelta: f.after.offdelta + 1 } }
    all {
      isByz(a), isProposed(r), signed.get(sigKey(a, f)) == 0, nextFid <= MAX_FRAMES,
      frames' = if (correct) frames else frames.set(nextFid, other_),
      nextFid' = if (correct) nextFid else nextFid + 1,
      signed' = signed.set(sigKey(a, f), if (correct) fid else nextFid),
      acks' = acks.union(Set(fid)),
      replica' = replica, proposals' = proposals, clock' = clock, firstCommit' = firstCommit, diverged' = diverged,
      equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  action receiveProposal(s: Side): bool = {
    nondet fid = proposals.filter(i => frames.get(i).author != s).oneOf()
    deliverProposal(s, fid)
  }

  // Ghost bookkeeping for agreement: the first commit at a height is remembered, the second must match it. One exception (A12, closed by the
  // coordinator): when a peer's key has been taken, it may have signed two proofs for one height, and at one proof nonce the chain ranks the Left-authored
  // one above the Right-authored one (rank = nonce * 2 + leftAuthored). The honest Right signed that Left-authored frame itself, so a later commit of it
  // over an earlier Right-authored commit is not a disagreement: it is the frame the chain settles. The reverse order is one.
  pure def mismatch(fc: int -> int, frames: int -> Frame, f: Frame, byzOn: bool): bool = and {
    fc.get(f.height) != 0, frames.get(fc.get(f.height)).after != f.after,
    // A12: the chain ranks a proof by nonce, then Left over Right. So a later Left-authored commit over an earlier Right-authored one is no fork only when its nonce is
    // not below the earlier one's; the exemption compares ranks and does not lean on MAX_NONCE_GAP = 0 (final review F9).
    not(byzOn and f.author == Left and frames.get(fc.get(f.height)).author == Right and f.nonce >= frames.get(fc.get(f.height)).nonce)
  }

  // The receiver, holding a validated frame, signs the frame and the resulting proof, commits, and answers.
  // At the Entity layer this is the moment its consensus certifies the ack (entity.qnt).
  action ackReceived(s: Side): bool = {
    val r = replica.get(s)
    val fid = statusFid(r)
    val f = frames.get(fid)
    all {
      not(isByz(s)),
      isReceived(r),
      replica' = replica.set(s, commit(r, fid, f)),
      signed' = signed.set(sigKey(s, f), fid),
      equivocated' = (equivocated or clashes(signed, frames, sigKey(s, f), f)),
      firstCommit' = if (firstCommit.get(f.height) == 0) firstCommit.set(f.height, fid) else firstCommit,
      diverged' = (diverged or mismatch(firstCommit, frames, f, byz != 0)),
      badCommit' = (badCommit or badCommitOf(r.tip, f, clock)), byz' = byz,
      acks' = acks.union(Set(fid)),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, clock' = clock,
      rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept
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
      not(isByz(s)),
      acks.contains(fid),
      f.author == s,
      replica' = if (fits) replica.set(s, commit(r, fid, f)) else replica,
      firstCommit' = if (fits and firstCommit.get(f.height) == 0) firstCommit.set(f.height, fid) else firstCommit,
      diverged' = (diverged or (fits and mismatch(firstCommit, frames, f, byz != 0))),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed,
      clock' = clock, equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept, badCommit' = (badCommit or (fits and badCommitOf(r.tip, f, clock))), byz' = byz
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
    rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
  }
  action loseAck(fid: int): bool = all {
    acks.contains(fid),
    acks' = acks.exclude(Set(fid)),
    replica' = replica, frames' = frames, nextFid' = nextFid, proposals' = proposals, signed' = signed,
    clock' = clock, firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
    rollbacks' = rollbacks, refusals' = refusals, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
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
    dropProposal, dropAck,
    { nondet a = SIDES.oneOf() turnByzantine(a) },
    { nondet a = SIDES.oneOf() nondet kind = 0.to(5).oneOf() nondet id = LOCK_SLOTS.oneOf() byzPropose(a, kind, id) },
    { nondet a = SIDES.oneOf() nondet future = BRANCHES.oneOf() byzStamped(a, future) },
    { nondet a = SIDES.oneOf() nondet correct = BRANCHES.oneOf() byzAck(a, correct) }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------------------------------------

  // P2 credit holds: every committed state, and every state a side holds in flight, satisfies RCPAN.
  // (Every committed body was once in flight, so checking the tip and the planning state checks them all.)
  val credit_holds: bool = SIDES.forall(s => {
    val r = replica.get(s)
    creditHolds(r.tip) and creditHolds(planning(r, frames))
  })

  // P4a agreed: the two sides never committed different bodies at one height.
  val agreed: bool = not(diverged)

  // P4b no equivocation: a signer never signs two different proofs for one (nonce, branch author).
  val no_equivocation: bool = not(equivocated)

  // P4c both sign the same proof: for the head of each side's history, both signatures over the proof of the body it
  // committed exist, on the branch that authored it.
  val both_signed: bool = SIDES.forall(s => {
    val r = replica.get(s)
    val o = other(s)
    if (isByz(s)) true                                  // the Byzantine side is not checked, only what the honest side committed
    else if (r.lastFid == 0) r.height == 0
    else {
      val f = frames.get(r.lastFid)
      // the Byzantine author's signature on its own frame is implied: it signs anything, and may sign two frames for one key
      val theirs = (isByz(o) and f.author == o) or and {
        signed.get(sigKey(o, f)) != 0, proofOf(frames.get(signed.get(sigKey(o, f))).after) == proofOf(r.tip)
      }
      and {
        f.height == r.height,
        f.after == r.tip,
        signed.get(sigKey(s, f)) != 0,
        proofOf(frames.get(signed.get(sigKey(s, f))).after) == proofOf(r.tip),
        theirs
      }
    }
  })

  // P4d a frame is held for an ack only if it is well formed: no forged state, no skipped height, no time rule judged by the frame's own stamp.
  val no_bad_accept: bool = not(badAccept)

  // P4e a committed frame never does what its author may not: spend the other side's funds, raise its own credit, expire a lock early.
  val authority: bool = not(badCommit)

  // P4f the proof nonce is its own counter (N1): every committed frame moved it up by at least one and at most 1 + MAX_NONCE_GAP, and the
  // side's counter is the nonce of the frame it committed last.
  val nonce_climbs: bool = SIDES.forall(s => {
    val r = replica.get(s)
    and {
      r.pnonce >= r.height, r.pnonce <= r.height * (1 + MAX_NONCE_GAP),
      r.lastFid == 0 or frames.get(r.lastFid).nonce == r.pnonce
    }
  })

  val safe: bool = and { credit_holds, agreed, no_equivocation, both_signed, no_bad_accept, authority, nonce_climbs }

  // Coverage witnesses: each is false on purpose, and `quint run --invariant` must find a violating trace.
  // A witness that cannot be violated means the path it names is unreachable in this model.
  val w_no_commit: bool = replica.get(Left).height == 0
  val w_no_two_commits: bool = replica.get(Right).height < 2
  val w_no_rollback: bool = rollbacks == 0
  val w_no_refusal: bool = refusals == 0
  // a Byzantine frame was sent: some frame in the arena was never signed by its author in the honest ledger
  // a Left-authored frame committed over a Right-authored one at the same height: a peer that acked and then equivocated (A12)
  val superseded: bool = SIDES.exists(s => {
    val r = replica.get(s)
    r.lastFid != 0 and firstCommit.get(frames.get(r.lastFid).height) != r.lastFid and firstCommit.get(frames.get(r.lastFid).height) != 0
  })
  val w_no_supersede: bool = not(superseded)
  val w_no_byz_frame: bool = not(1.to(MAX_FRAMES).exists(i => and { i < nextFid, signed.get(sigKey(frames.get(i).author, frames.get(i))) != i }))
  val w_no_lock: bool = lockCount(replica.get(Left).tip) == 0
  val w_no_paid: bool = replica.get(Left).tip.offdelta == 0
}
