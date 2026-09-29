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
    nondet dl = 1.to(MAX_LOCK_HORIZON).oneOf()
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
