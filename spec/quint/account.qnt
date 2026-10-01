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
  var nacks: Set[Refusal]            // refusals in flight to the author of the frame they name [R-FRAME-REFUSAL]; values, so a frame refused twice with one answer is one message
  var signed: SigKey -> int          // the frame each (signer, nonce, branch) signature was made for; 0 = none
  var clock: Side -> int
  var firstCommit: int -> int        // ghost: per height, the frame the first side to commit it committed
  var diverged: bool                 // ghost: the two sides committed different bodies at one height
  var equivocated: bool              // ghost: a signer was about to sign a second, different proof for one key
  var rollbacks: int                 // ghost: proposals rolled back on collision (the loser's, by rank)
  var refusals: int                  // ghost: peer frames refused
  var byz: int                       // 0 both sides honest; 1 Left is Byzantine, 2 Right is (chosen once, at any moment): the honest side is checked, the Byzantine one only sends
  var badCommit: bool                // ghost: a committed frame did what its author may not (see `badEffect`, `expiredEarly`)
  var badAccept: bool                // ghost: a replica held a frame for its ack that a correct receiver must have refused (see `wellFormed`)
  var relBad: bool                   // ghost: a lock's notice (the payer's release) was given while a proof this side signed and no commit superseded still held the lock, deadline and reserve not passed (see `releaseBad`)

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

  // R-SIGNED-IS-LIVE, stated on the signed-proof history and not through the replica's own bookkeeping (`sigLocks`, `kept`): the payer's release of a lock (a
  // notice, `refused`) while some proof that was signed (by either side) holds that very lock, that no committed frame has superseded (its rank is above the head's),
  // and the deadline plus the reserve has not passed on the releasing side's own clock. Evaluated at the moment a notice is given.
  pure def rankOfKey(k: SigKey): int = k._2 * 2 + (if (k._3) 1 else 0)
  pure def headRank(frames: int -> Frame, r: Replica): int = if (r.lastFid == 0) 0 else proofRank(frames.get(r.lastFid))
  pure def liveSignedHolds(sg: SigKey -> int, frames: int -> Frame, r: Replica, now: int, tx: Tx): bool = match tx {
    | HtlcLock(l) => and {
        LOCK_SLOTS.contains(l.id),
        now <= l.deadline + CLOCK_RESERVE,
        sg.keys().exists(k => and {
          sg.get(k) != 0,
          rankOfKey(k) > headRank(frames, r),
          frames.get(sg.get(k)).after.locks.get(l.id) == { on: true, payer: l.payer, amount: l.amount, hashlock: l.hashlock, deadline: l.deadline }
        })
      }
    | _ => false
  }
  // the notices a transition added (`refused` only grows) that released a lock held by a live signed proof
  pure def releaseBad(sg: SigKey -> int, frames: int -> Frame, before: Replica, after: Replica, now: int): bool = {
    val added = after.refused.slice(before.refused.length(), after.refused.length())
    added.indices().exists(i => liveSignedHolds(sg, frames, after, now, added[i]))
  }

  def isByz(s: Side): bool = byz == (match s { | Left => 1 | Right => 2 })

  action init = all {
    replica' = SIDES.mapBy(_ => EMPTY_REPLICA),
    frames' = 0.to(MAX_FRAMES).mapBy(_ => NO_FRAME),
    nextFid' = 1,
    proposals' = Set(), acks' = Set(), nacks' = Set(),
    signed' = tuples(SIDES, 0.to(MAX_NONCE), BRANCHES).mapBy(_ => 0),
    clock' = SIDES.mapBy(_ => 0),
    firstCommit' = 0.to(MAX_HEIGHT).mapBy(_ => 0),
    diverged' = false, equivocated' = false, rollbacks' = 0, refusals' = 0, badAccept' = false, badCommit' = false, relBad' = false, byz' = 0
  }

  // Time passes on one side's clock. The two clocks may not drift apart by more than DRIFT (assumption).
  action tick(s: Side): bool = all {
    clock.get(s) < MAX_CLOCK,
    clock.get(s) + 1 - clock.get(other(s)) <= DRIFT,
    clock' = clock.set(s, clock.get(s) + 1),
    replica' = replica, frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed,
    firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
    rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
  }

  // Queue `tx` on side `s`. Scripted form, so tests can drive exact scenarios; `enqueue` below tries every tx.
  action enqueueTx(s: Side, tx: Tx): bool = {
    val r = replica.get(s)
    all {
      not(isByz(s)),
      admits(r, planning(r, frames), clock.get(s), s, tx),
      replica' = replica.set(s, { ...r, mempool: r.mempool.append(tx), submitted: r.submitted + 1 }),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed,
      clock' = clock, firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
      rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
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
    val cut = withNotice({ ...r, status: Proposed(nextFid), mempool: List() }, keepValid(r.tip, r.mempool, s, clock.get(s)).dropped)     // the txs that no longer apply leave with notice
    all {
      not(isByz(s)),
      canPropose(r, clock.get(s), s),
      nextFid <= MAX_FRAMES,
      replica' = replica.set(s, signsFrame(cut, f)),
      relBad' = (relBad or releaseBad(signed, frames, r, cut, clock.get(s))),
      frames' = frames.set(nextFid, f),
      nextFid' = nextFid + 1,
      proposals' = proposals.union(Set(nextFid)),
      signed' = signed.set(sigKey(s, f), nextFid),
      equivocated' = (equivocated or clashes(signed, frames, sigKey(s, f), f)),
      acks' = acks, clock' = clock, firstCommit' = firstCommit, diverged' = diverged,
      rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  // R-NOTICE: a tx in the mempool that no longer applies on the committed head (a collision winner took its slot, credit was used up) is
  // refused with notice and leaves the mempool, without waiting for a frame that could carry it. Never dropped silently, never stuck there.
  action reviseMempool(s: Side): bool = {
    val r = replica.get(s)
    val sel = keepValid(r.tip, r.mempool, s, clock.get(s))
    val cut = withNotice({ ...r, mempool: sel.txs }, sel.dropped)
    all {
      not(isByz(s)),
      isOpen(r),
      sel.dropped.length() > 0,
      replica' = replica.set(s, cut),
      relBad' = (relBad or releaseBad(signed, frames, r, cut, clock.get(s))),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed,
      clock' = clock, firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
      rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
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
      rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
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
      nacks' = if (o.say.fid != 0) nacks.union(Set(o.say)) else nacks,
      rollbacks' = if (o.rolled) rollbacks + 1 else rollbacks,
      refusals' = if (o.refused) refusals + 1 else refusals,
      relBad' = relBad, badAccept' = (badAccept or (heldNow(r, o.r, fid) and not(wellFormed(r, clock.get(s), f)))), badCommit' = badCommit, byz' = byz,
      frames' = frames, nextFid' = nextFid, proposals' = proposals, signed' = signed, clock' = clock,
      firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated
    }
  }

  pure def secretOfHash(h: int): int = h - 10        // the adversary knows every secret: the inverse of hashOf
  pure val FAULTS = Set("not_expired", "deadline_too_far", "deadline_past", "bad_state", "stale_attempt", "frozen")   // the faults a Byzantine receiver names: three retryable, one stale, two that drop

  // What a correct receiver must have checked before it holds a frame for its ack, stated again here on purpose (the mechanism is
  // `acceptable` in account_core): the next height, and a claimed state equal to the replay of the frame's txs on its tip at its OWN
  // clock. The frame's timestamp is not part of it [R-CLOCK]. A frame that fails and is still held is a bug.
  pure def wellFormed(r: Replica, now: int, f: Frame): bool = {
    val replays = match replay(r.tip, f.txs, f.author, now) { | Ok(b) => b == f.after | Refused(_) => false }
    // R-FRAME-REFUSAL: and above the mark: a frame it has refused (at this attempt or a higher one) on this head is never held
    val abovePlace = match r.mark { | Declined(m) => f.attempt > m.attempt | NoMark => true }
    // R-PROOF-NONCE-ABOVE-SIGNED: and its proof outranks every proof the receiver signed (the chain's rank: nonce, then Left over Right), within one above what it knows signed
    val aboveSigned = (f.nonce * 2 + (if (f.author == Left) 1 else 0)) > r.sig
    and { f.parent == r.lastFid, f.height == r.height + 1, f.nonce > r.pnonce, f.nonce <= r.hi + 1 + MAX_NONCE_GAP, aboveSigned, replays, abovePlace }
  }
  pure def heldNow(before: Replica, after: Replica, fid: int): bool =
    isReceived(after) and statusFid(after) == fid and not(isReceived(before) and statusFid(before) == fid)

  // A Byzantine proposer (the author's key is in the adversary's hands): it sends the honest side a frame that no correct proposer
  // would send, built on the receiver's exact tip and clock so that the only fault is the one named. The Byzantine author's signature is
  // implied (it signs anything, and may sign two frames for one key), so `signed` is not touched. The honest side signs only what it
  // accepts, and every one of these is refused now (one that later fits its height is a frame like any other).
  //   0 a claimed state that is not the replay of the txs   1 a skipped height
  //   4 a proof nonce that is not above the last committed one   5 a proof nonce that leaps more than MAX_NONCE_GAP (N1)
  //   6 a frame whose parent is not the receiver's head (R-PARENT)
  //   2 an expiry of an open lock, stamped far in the future, before the receiver's own clock is past the deadline and the reserve
  //   3 a resolve of an open lock with its secret, stamped in the past, after the receiver's own clock has passed the deadline
  // (Old and future stamps on frames that are otherwise correct are accepted, by R-CLOCK: `oldFrameIsAcceptedAfterAnOutageTest`.)
  action byzProposeAt(a: Side, kind: int, id: int, att: int): bool = {
    val rcv = other(a)
    val r = replica.get(rcv)
    val now = clock.get(rcv)
    val lock = r.tip.locks.get(id)
    val gone = { ...r.tip, locks: r.tip.locks.set(id, NO_LOCK) }
    val n = imax(r.pnonce, r.hi) + 1                    // a proof nonce one above everything the receiver knows signed: the only fault of a frame is the one named
    val f: Frame =
      if (kind == 0) { height: r.height + 1, parent: r.lastFid, nonce: n, ts: now, author: a, txs: List(), after: { ...r.tip, offdelta: r.tip.offdelta + 1 }, attempt: att }
      else if (kind == 1) { height: r.height + 2, parent: r.lastFid, nonce: n, ts: now, author: a, txs: List(), after: r.tip, attempt: att }
      else if (kind == 2) { height: r.height + 1, parent: r.lastFid, nonce: n, ts: now + 100, author: a, txs: [HtlcExpire({ id: id })], after: gone, attempt: att }
      else if (kind == 3) { height: r.height + 1, parent: r.lastFid, nonce: n, ts: 0, author: a, txs: [HtlcResolve({ id: id, secret: secretOfHash(lock.hashlock) })],
             after: { ...gone, offdelta: if (lock.payer == Left) r.tip.offdelta - lock.amount else r.tip.offdelta + lock.amount }, attempt: att }
      else if (kind == 4) { height: r.height + 1, parent: r.lastFid, nonce: r.pnonce, ts: now, author: a, txs: List(), after: r.tip, attempt: att }                            // N1: a proof nonce that is not above the last
      else if (kind == 5) { height: r.height + 1, parent: r.lastFid, nonce: imax(r.pnonce, r.hi) + 2 + MAX_NONCE_GAP, ts: now, author: a, txs: List(), after: r.tip, attempt: att }   // N1: a leap
      else { height: r.height + 1, parent: 99, nonce: n, ts: now, author: a, txs: List(), after: r.tip, attempt: att }                                      // R-PARENT: a frame that does not extend my head
    all {
      isByz(a), r.height < MAX_HEIGHT,          // the search bound: a frame above MAX_HEIGHT is outside the signature map
      kind >= 0, kind <= 6,
      LOCK_SLOTS.contains(id),
      if (kind == 2 or kind == 3) and { lock.on, if (kind == 2) now <= lock.deadline + CLOCK_RESERVE else and { now > lock.deadline, payee(lock) == a } } else true,
      nextFid <= MAX_FRAMES,
      frames' = frames.set(nextFid, f),
      nextFid' = nextFid + 1,
      proposals' = proposals.union(Set(nextFid)),
      replica' = replica, acks' = acks, signed' = signed, clock' = clock, firstCommit' = firstCommit, diverged' = diverged,
      equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }
  action byzPropose(a: Side, kind: int, id: int): bool = byzProposeAt(a, kind, id, 0)

  // One side turns Byzantine (its key is taken) at any moment; from then on only the other side is honest and only it is checked.
  action turnByzantine(a: Side): bool = all {
    byz == 0,
    byz' = (match a { | Left => 1 | Right => 2 }),
    replica' = replica, frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed, clock' = clock,
    firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks,
    relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit
  }

  // A Byzantine frame that is correct except for its stamp: the next height, the empty replay, signed by its author. The stamp is
  // 0 or far ahead of every clock. Accepted (R-CLOCK), so it is committed like any other frame and both sides hold both signatures.
  action byzStampedAt(a: Side, future: bool, att: int): bool = {
    val rcv = other(a)
    val r = replica.get(rcv)
    val f: Frame = { height: r.height + 1, parent: r.lastFid, nonce: r.pnonce + 1, ts: if (future) clock.get(rcv) + 100 else 0, author: a, txs: List(), after: r.tip, attempt: att }
    all {
      isByz(a), r.height < MAX_HEIGHT, nextFid <= MAX_FRAMES,
      frames' = frames.set(nextFid, f),
      nextFid' = nextFid + 1,
      proposals' = proposals.union(Set(nextFid)),
      signed' = signed,
      replica' = replica, acks' = acks, clock' = clock, firstCommit' = firstCommit, diverged' = diverged,
      equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  action byzStamped(a: Side, future: bool): bool = byzStampedAt(a, future, 0)

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
      equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
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
      equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  action receiveProposal(s: Side): bool = {
    nondet fid = proposals.filter(i => frames.get(i).author != s).oneOf()
    deliverProposal(s, fid)
  }

  // Ghost bookkeeping for agreement: the first commit at a height is remembered, the second must match it. One exception (A12, closed by the
  // coordinator): when a peer's key has been taken, it may have signed two proofs for one height (it acked a frame and then sent another, or refused it and
  // acked the retry), and the chain ranks a proof by nonce, then Left over Right (rank = nonce * 2 + leftAuthored). The honest side signed the later frame itself, so a
  // later commit of a frame whose rank is ABOVE the earlier commit's is not a disagreement: it is the frame the chain settles. The reverse order is one.
  // [A12 first named only a Left-authored frame over a Right-authored one at a nonce not below; a longer simulation (1500 traces, seed 0x3) found the same fork with
  // two Right-authored frames: a peer that acks, refuses the frame it acked (its ack lost) and acks the retry, which is at a higher nonce. Both are the rank rule.]
  pure def mismatch(fc: int -> int, frames: int -> Frame, f: Frame, byzOn: bool): bool = and {
    fc.get(f.height) != 0, frames.get(fc.get(f.height)).after != f.after,
    not(byzOn and proofRank(f) > proofRank(frames.get(fc.get(f.height))))
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
      replica' = replica.set(s, commit(r, s, fid, f)),
      signed' = signed.set(sigKey(s, f), fid),
      equivocated' = (equivocated or clashes(signed, frames, sigKey(s, f), f)),
      firstCommit' = if (firstCommit.get(f.height) == 0) firstCommit.set(f.height, fid) else firstCommit,
      diverged' = (diverged or mismatch(firstCommit, frames, f, byz != 0)),
      badCommit' = (badCommit or badCommitOf(r.tip, f, clock)), byz' = byz,
      acks' = acks.union(Set(fid)),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, clock' = clock,
      rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, relBad' = relBad, badAccept' = badAccept
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
      replica' = if (fits) replica.set(s, commit(r, s, fid, f)) else replica,
      firstCommit' = if (fits and firstCommit.get(f.height) == 0) firstCommit.set(f.height, fid) else firstCommit,
      diverged' = (diverged or (fits and mismatch(firstCommit, frames, f, byz != 0))),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed,
      clock' = clock, equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, relBad' = relBad, badAccept' = badAccept, badCommit' = (badCommit or (fits and badCommitOf(r.tip, f, clock))), byz' = byz
    }
  }

  action receiveAck(s: Side): bool = {
    nondet fid = acks.filter(i => frames.get(i).author == s).oneOf()
    deliverAck(s, fid)
  }

  // [R-FRAME-REFUSAL] The proposer receives the refusal of frame `ref.fid`. `onRefusal` decides: it rolls the pending frame back, requeues or drops with
  // notice, and sets the next attempt; a refusal for any other frame changes nothing. Scripted form; `receiveRefusal` picks any refusal in flight.
  action deliverRefusal(s: Side, ref: Refusal): bool = {
    val r = replica.get(s)
    val r2 = onRefusal(r, ref, frames.get(ref.fid))
    all {
      not(isByz(s)),
      nacks.contains(ref),
      frames.get(ref.fid).author == s,
      replica' = replica.set(s, r2),
      relBad' = (relBad or releaseBad(signed, frames, r, r2, clock.get(s))),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, nacks' = nacks, signed' = signed, clock' = clock,
      firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals,
      badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  // [R-SIGNED-IS-LIVE] The notice of a lock cut from a signed proof is held (`kept`) and given when the proof no longer holds the lock: a frame above it has committed
  // (`sigLocks` is pruned at the commit), or the deadline plus the reserve has passed on this side's own clock. This is the release of the payer's hold, and of the
  // upstream hold the Entity above keeps for the lock. A refusal alone does not release it.
  action releaseHold(s: Side): bool = {
    val r = replica.get(s)
    val r2 = releaseDue(r, clock.get(s))
    all {
      not(isByz(s)),
      r.kept.length() > r2.kept.length(),
      replica' = replica.set(s, r2),
      relBad' = (relBad or releaseBad(signed, frames, r, r2, clock.get(s))),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, nacks' = nacks, signed' = signed, clock' = clock,
      firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals,
      badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  // [R-COSIGN-FREEZE] A side co-signs a settlement or a reserve-to-collateral: the signed fold carries the offdelta of the head it was taken at (`fold`, `foldH`). From then on it
  // proposes no frame (`canPropose`) and refuses every peer frame with a retryable `frozen` refusal (`judge`), until the operation lands, is superseded, or the host reports it
  // lapsed (`thaw`: the one action standing for the three; the epoch the landing opens is `settle.qnt`'s). It co-signs only at a head with nothing in flight: no frame proposed or held.
  action cosign(s: Side): bool = {
    val r = replica.get(s)
    all {
      not(isByz(s)),
      isOpen(r), not(r.frozen),
      replica' = replica.set(s, { ...r, frozen: true, foldH: r.height, fold: r.tip.offdelta }),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, nacks' = nacks, signed' = signed, clock' = clock,
      firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals,
      relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  action thaw(s: Side): bool = {
    val r = replica.get(s)
    all {
      not(isByz(s)),
      r.frozen,
      replica' = replica.set(s, { ...r, frozen: false }),
      frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, nacks' = nacks, signed' = signed, clock' = clock,
      firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals,
      relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
    }
  }

  action receiveRefusal(s: Side): bool = {
    nondet ref = nacks.filter(x => frames.get(x.fid).author == s).oneOf()
    deliverRefusal(s, ref)
  }

  // A Byzantine peer answers a frame of the honest side with a refusal of its own making: any fault, any index, any mark, any floor. It can only make the honest
  // proposer roll its pending frame back and drop the tx it names, with notice, or send its txs again: the honest side must neither lose a tx, nor
  // commit on it, nor hold its Account up for ever by a mark that leaps (the attempt only counts up, a frame is judged again at the next one).
  action byzNack(a: Side, fid: int, index: int, fault: str, mark: int, hi: int): bool = all {
    isByz(a),
    fid >= 1, fid < nextFid,
    frames.get(fid).author == other(a),
    nacks' = nacks.union(Set({ ...refusalFor(fid, index, fault, mark), hi: hi })),
    replica' = replica, frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed, clock' = clock,
    firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated, rollbacks' = rollbacks, refusals' = refusals,
    relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
  }

  // The network loses a message. Scripted forms name the message; `dropProposal` / `dropAck` / `dropNack` lose any one.
  action loseProposal(fid: int): bool = all {
    proposals.contains(fid),
    proposals' = proposals.exclude(Set(fid)),
    replica' = replica, frames' = frames, nextFid' = nextFid, acks' = acks, signed' = signed,
    clock' = clock, firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
    rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
  }
  action loseAck(fid: int): bool = all {
    acks.contains(fid),
    acks' = acks.exclude(Set(fid)),
    replica' = replica, frames' = frames, nextFid' = nextFid, proposals' = proposals, signed' = signed,
    clock' = clock, firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
    rollbacks' = rollbacks, refusals' = refusals, nacks' = nacks, relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
  }
  action loseNack(ref: Refusal): bool = all {
    nacks.contains(ref),
    nacks' = nacks.exclude(Set(ref)),
    replica' = replica, frames' = frames, nextFid' = nextFid, proposals' = proposals, acks' = acks, signed' = signed,
    clock' = clock, firstCommit' = firstCommit, diverged' = diverged, equivocated' = equivocated,
    rollbacks' = rollbacks, refusals' = refusals, relBad' = relBad, badAccept' = badAccept, badCommit' = badCommit, byz' = byz
  }
  action dropProposal: bool = { nondet fid = proposals.oneOf() loseProposal(fid) }
  action dropAck: bool = { nondet fid = acks.oneOf() loseAck(fid) }
  action dropNack: bool = { nondet ref = nacks.oneOf() loseNack(ref) }

  action step = any {
    tick(Left), tick(Right),
    enqueue(Left), enqueue(Right),
    propose(Left), propose(Right),
    reviseMempool(Left), reviseMempool(Right),
    resend(Left), resend(Right),
    receiveProposal(Left), receiveProposal(Right),
    ackReceived(Left), ackReceived(Right),
    receiveAck(Left), receiveAck(Right),
    receiveRefusal(Left), receiveRefusal(Right),
    releaseHold(Left), releaseHold(Right),
    cosign(Left), cosign(Right), thaw(Left), thaw(Right),
    dropProposal, dropAck, dropNack,
    { nondet a = SIDES.oneOf() turnByzantine(a) },
    { nondet a = SIDES.oneOf() nondet kind = 0.to(6).oneOf() nondet id = LOCK_SLOTS.oneOf() nondet att = 0.to(MAX_ATTEMPT + 1).oneOf() byzProposeAt(a, kind, id, att) },
    { nondet a = SIDES.oneOf() nondet future = BRANCHES.oneOf() nondet att = 0.to(MAX_ATTEMPT + 1).oneOf() byzStampedAt(a, future, att) },
    { nondet a = SIDES.oneOf() nondet correct = BRANCHES.oneOf() byzAck(a, correct) },
    { nondet a = SIDES.oneOf() nondet fid = 1.to(MAX_FRAMES).oneOf() nondet index = 0.to(MAX_MEMPOOL).oneOf() nondet fault = FAULTS.oneOf() nondet mark = 0.to(MAX_ATTEMPT + 1).oneOf() nondet hi = 0.to(MAX_HEIGHT + MAX_ATTEMPT + 2).oneOf() byzNack(a, fid, index, fault, mark, hi) }
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

  // P4f the proof nonce is its own counter (N1): every committed frame moved it up by at least one, the side's counter is the nonce of the frame it committed last,
  // and the only nonces it skipped are ones a signed proof occupies (a refused or yielded attempt: A18, A19). Not checked once a side is Byzantine: the honest side
  // also counts the nonces of the Byzantine frames it saw, which no signature of the honest ledger records.
  val nonce_climbs: bool = SIDES.forall(s => {
    val r = replica.get(s)
    val f = frames.get(r.lastFid)
    val before = if (f.parent == 0) 0 else frames.get(f.parent).nonce
    and {
      r.pnonce >= r.height,
      r.lastFid == 0 or and {
        f.nonce == r.pnonce, f.nonce > before,
        byz != 0 or (before + 1).to(f.nonce - 1).forall(m => SIDES.exists(sd => BRANCHES.exists(b => signed.get((sd, m, b)) != 0)))
      }
    }
  })

  // P4g R-PROOF-NONCE-ABOVE-SIGNED, on the signed-proof history and not through the guard that enforces it (`hi`, `sig`, `nonceOk`): no proof that was signed in the
  // epoch outranks the committed head, except the head's own proofs and the live proposals built on it. A stale proof (a yielded or refused attempt, a collision loser's)
  // that outranks the head by the chain's rank (nonce * 2 + leftAuthored) lets the peer start a dispute with it and erase the frames committed after it. Checked for the
  // honest side's head and for the proofs the honest side signed (a Byzantine side's own signatures cannot hurt it).
  pure def onChain(r: Replica, frames: int -> Frame, gid: int): bool = {
    val p1 = frames.get(r.lastFid).parent
    val p2 = frames.get(p1).parent
    Set(r.lastFid, p1, p2).contains(gid)
  }
  val signed_above_head: bool = SIDES.forall(s => {
    val r = replica.get(s)
    isByz(s) or r.lastFid == 0 or signed.keys().forall(k => {
      val gid = signed.get(k)
      val g = frames.get(gid)
      or {
        gid == 0, isByz(k._1), onChain(r, frames, gid),
        and { g.height > r.height, Set(g.parent, frames.get(g.parent).parent, frames.get(frames.get(g.parent).parent).parent).contains(r.lastFid) },   // a live proposal on this head, or built on one: not stale yet
        rankOfKey(k) < headRank(frames, r)
      }
    })
  })

  // P4i R-PROOF-NONCE-ABOVE-SIGNED, the floor a refusal carries: an honest refuser's floor is at most one above what the proposer knows signed (its own latest proof, which the
  // proposer has not seen, and nothing more), so the bound `onRefusal` enforces never refuses an honest refusal. Stated on the refusals in flight and the proposer's `hi`.
  val refusal_floor_reachable: bool = byz != 0 or nacks.forall(x => x.hi <= replica.get(frames.get(x.fid).author).hi + 1 + MAX_NONCE_GAP)

  // P4j R-COSIGN-FREEZE, stated on the signed fold against the off-chain state and not through the guards (`canPropose`, `acceptable`): while a side is frozen the offdelta of
  // its committed head is the offdelta its co-signed fold carries, at the height the fold was taken at, and it has no frame in flight or held. A frame it accepted after the
  // fold (an offdelta that moved) or proposed would have settled a different balance than the one the chain was given.
  val cosign_fold_holds: bool = SIDES.forall(s => {
    val r = replica.get(s)
    isByz(s) or not(r.frozen) or and { r.height == r.foldH, r.tip.offdelta == r.fold, isOpen(r) }
  })

  // P4h R-SIGNED-IS-LIVE: no lock's notice (the payer's release, and the upstream hold's) was given while a signed proof that no commit superseded still held the lock,
  // unless the deadline and the reserve had passed. Set at the moment a notice is given (`releaseBad`), from the signed history.
  val no_release_while_signed_live: bool = not(relBad)

  // R-NOTICE: no admitted tx is lost. Every tx a side admitted to its mempool is in a frame it committed as author, in its mempool, in the frame it
  // has in flight, or refused with notice. The count is the evidence: txs are values, and two equal ones are two txs.
  val no_tx_lost: bool = SIDES.forall(s => {
    val r = replica.get(s)
    val inFlight = match r.status { | Proposed(fid) => frames.get(fid).txs.length() | _ => 0 }
    isByz(s) or r.submitted == r.done + r.mempool.length() + inFlight + r.refused.length() + r.kept.length()
  })

  // R-FRAME-REFUSAL: no fork by a refused frame. A side never holds as committed a peer's frame that its author has given up: the author has committed it
  // too (it is at that height or above), or still has it in flight. The author gives a frame up when a refusal for it arrives; the receiver, having refused
  // it, must therefore never take it on this head, whatever its view of J does later (the mark). Not checked with a Byzantine side, whose replica is not the protocol's.
  val no_orphan: bool = SIDES.forall(s => {
    val r = replica.get(s)
    val f = frames.get(r.lastFid)
    val a = replica.get(f.author)
    or { byz != 0, r.lastFid == 0, f.author == s, a.height >= f.height, isProposed(a) and statusFid(a) == r.lastFid }
  })

  val safe: bool = and { credit_holds, agreed, no_equivocation, both_signed, no_bad_accept, authority, nonce_climbs, no_tx_lost, no_orphan, signed_above_head, no_release_while_signed_live, refusal_floor_reachable, cosign_fold_holds }

  // Coverage witnesses: each is false on purpose, and `quint run --invariant` must find a violating trace.
  // A witness that cannot be violated means the path it names is unreachable in this model.
  val w_no_commit: bool = replica.get(Left).height == 0
  val w_no_two_commits: bool = replica.get(Right).height < 2
  val w_no_rollback: bool = rollbacks == 0
  val w_no_refusal: bool = refusals == 0
  val w_no_nack: bool = nacks == Set()                                                                   // a refusal was sent back to a proposer
  val w_no_retry: bool = not(1.to(MAX_FRAMES).exists(i => and { i < nextFid, frames.get(i).attempt > 0 }))  // a refused frame was sent again, at the next attempt
  // a Byzantine frame was sent: some frame in the arena was never signed by its author in the honest ledger
  // a Left-authored frame committed over a Right-authored one at the same height: a peer that acked and then equivocated (A12)
  val superseded: bool = SIDES.exists(s => {
    val r = replica.get(s)
    r.lastFid != 0 and firstCommit.get(frames.get(r.lastFid).height) != r.lastFid and firstCommit.get(frames.get(r.lastFid).height) != 0
  })
  val w_no_supersede: bool = not(superseded)
  val w_no_byz_frame: bool = not(1.to(MAX_FRAMES).exists(i => and { i < nextFid, signed.get(sigKey(frames.get(i).author, frames.get(i))) != i }))
  val w_no_notice: bool = SIDES.forall(s => replica.get(s).refused.length() == 0)
  val w_no_nonce_low: bool = not(nacks.exists(x => x.fault == "nonce_low"))                               // a receiver refused a proof that would not outrank one it signed (R-PROOF-NONCE-ABOVE-SIGNED)
  val w_no_frozen: bool = SIDES.forall(s => not(replica.get(s).frozen))                                         // a side co-signed a fold and is frozen (R-COSIGN-FREEZE)
  val w_no_frozen_refusal: bool = not(nacks.exists(x => x.fault == "frozen"))                                  // a frozen side refused a peer frame
  val w_no_kept: bool = SIDES.forall(s => replica.get(s).kept.length() == 0)                               // a lock's notice was held for its signed proof (R-SIGNED-IS-LIVE)
  val w_no_stale_signed: bool = not(SIDES.exists(s => {                                                   // a signed proof of a frame that did not commit sits below the head: the case the oracle judges
    val r = replica.get(s)
    r.lastFid != 0 and signed.keys().exists(k => and { signed.get(k) != 0, not(onChain(r, frames, signed.get(k))), frames.get(signed.get(k)).height <= r.height })
  }))
  val w_no_lock: bool = lockCount(replica.get(Left).tip) == 0
  val w_no_paid: bool = replica.get(Left).tip.offdelta == 0
}
