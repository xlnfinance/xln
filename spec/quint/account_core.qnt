// XLN Account layer, the pure part: types, the transition table and the replica rules. account.qnt puts the state machine on it,
// entity.qnt uses it as it is. Every definition here is a pure function of its arguments.
module account_core {
  // ---------------------------------------------------------------------------------------------------------
  // Parameters. Small on purpose: Apalache explores every value in these ranges.
  // ---------------------------------------------------------------------------------------------------------

  pure val COLLATERAL = 2        // agreed on-chain collateral; ondelta is 0 here (chain moves arrive with settle.qnt)
  pure val MAX_AMOUNT = 3        // one payment or lock is between 1 and MAX_AMOUNT
  pure val MAX_CREDIT = 3        // a credit limit is between 0 and MAX_CREDIT
  pure val MAX_HEIGHT = 3        // frames per run; bounds the search
  pure val MAX_FRAMES = 8        // frame arena size: every proposal, including the ones rolled back
  pure val MAX_MEMPOOL = 2
  pure val MAX_CLOCK = 4         // J heights: `clock` is each party's own view of the J height [R-HTLC-CLOCK], never a timestamp a counterparty wrote
  pure val DRIFT = 1             // the two views never differ by more than this: each lags the chain by at most LAG, so DRIFT = LAG (R-DRIFT; params_test pins it)
  pure val CLOCK_RESERVE = DRIFT // R-HTLC-CLOCK b: the reserve, in J heights and at least LAG, that an expiry adds to the deciding party's own view
  // N1: the proof nonce is its own counter (a dispute proof carries it; the chain wants each start above the stored one), no longer the
  // frame height. Within an epoch it follows the tip by one. A proposer that could skip nonces on its own would let an abandoned, signed
  // proposal outrank the frame that was committed (a collision loser at nonce n+1 against the winner at n; the loser's next frame at n+1
  // again signs a second proof under one key). So 0 here; the mutant `proposer-may-skip-nonces` sets it to 1 and `no_equivocation` catches it.
  // The only jump is not a frame's: by R-IMPLICIT-BASELINE the first signed proof of a new ondelta epoch takes the chain's stored nonce + 2
  // (settle.qnt `FIRST_GAP`: a Right-authored proof at stored + 1 only ties the implicit proof of the epoch, chain.qnt `implicitProof`), and the
  // epoch's own counter is gapless after it. That first nonce is read from the chain when an epoch opens, never derived from the Account's own frames.
  pure val MAX_NONCE_GAP = 0
  pure val MAX_NONCE = MAX_HEIGHT * (1 + MAX_NONCE_GAP)
  pure val MAX_LOCK_HORIZON = 4  // policy parameter (coordinator, N2: 7 days by default, never below the 24 h async window): a lock's deadline is at most this far after the frame that opens it, at admission and at forward (room for a two-hop chain)
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
  type Frame = { height: int, parent: int, nonce: int, ts: int, author: Side, txs: List[Tx], after: Body }   // parent: the id of the frame this one extends (0 = genesis), the wire's parent hash [R-PARENT]; ts: the proposer's view when it built the frame; no decision reads it [R-CLOCK]

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
    refused: List[Tx],         // the txs this side proposed that no longer applied: refused with notice, never dropped silently [R-NOTICE]
    submitted: int,            // ghost: txs ever admitted to the mempool
    done: int,                 // ghost: own txs in frames this side has committed as their author
    pnonce: int,               // the proof nonce of the last committed frame: the nonce a dispute start would carry [N1]
    tip: Body,                 // the last committed body
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

  // R-SETTLE-CREDIT (coordinator 09-30, Q-X-3): a party co-signs a settlement that withdraws `w` of collateral for `by` only if, after it,
  // each side's position is still within the credit the other side extended: the bound a payment respects, taken over the smaller
  // collateral. A Left withdrawal lowers Left's allocation (Δ) with the collateral; a Right withdrawal leaves Δ where it is. A
  // withdrawal beyond one's own claim is refused. The contract accepts such a settlement (credit is off-chain, R-A6), so the approver is the only guard.
  pure def settlementOk(b: Body, by: Side, w: int): bool = {
    val coll = COLLATERAL - w
    val d = delta(b) - (if (by == Left) w else 0)
    and {
      w >= 1, w <= COLLATERAL,
      d >= -b.limitLeft,
      d <= coll + b.limitRight,
      d - holds(b, Left) >= -b.limitLeft,
      d + holds(b, Right) <= coll + b.limitRight
    }
  }

  // P2 stated on the outcomes and not through `rcpan`: whichever subset of the open clauses resolves in favour of its payee, the
  // allocation stays inside [-limitLeft, COLLATERAL + limitRight]. Every subset is enumerated; the guards use `rcpan`, the properties
  // use this, so a wrong `rcpan` does not weaken the check that is meant to catch it.
  pure def creditHolds(b: Body): bool = LOCK_SLOTS.powerset().forall(chosen => {
    val moved = chosen.fold(0, (acc, i) => {
      val l = b.locks.get(i)
      acc + (if (not(l.on)) 0 else if (l.payer == Left) -l.amount else l.amount)
    })
    and { b.offdelta + moved >= -b.limitLeft, b.offdelta + moved <= COLLATERAL + b.limitRight }
  })

  pure def proofOf(b: Body): Proof = { offdelta: b.offdelta, locks: b.locks }

  pure val NO_LOCK: Lock = { on: false, payer: Left, amount: 0, hashlock: 0, deadline: 0 }
  pure val GENESIS: Body =
    { offdelta: 0, limitLeft: 0, limitRight: 0, locks: LOCK_SLOTS.mapBy(_ => NO_LOCK) }

  pure def payee(l: Lock): Side = other(l.payer)

  // ---------------------------------------------------------------------------------------------------------
  // The transition table. `author` proposes the frame; `now` is the clock of the party that is deciding (the proposer when it builds the
  // frame, the receiver when it checks it): never the frame's timestamp [R-CLOCK].
  // Every refusal is a value: nothing here can halt a Runtime [R-X1].
  // ---------------------------------------------------------------------------------------------------------

  pure def withLock(b: Body, id: int, l: Lock): Body = { ...b, locks: b.locks.set(id, l) }

  pure def applyTx(b: Body, tx: Tx, author: Side, now: int): Res = match tx {
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
        else if (LOCK_SLOTS.exists(i => b.locks.get(i).on and b.locks.get(i).hashlock == l.hashlock)) Refused("lock_exists")   // R-ONE-LOCK-PER-HASH: one open clause per hashlock, whoever the payer
        else if (l.deadline <= now) Refused("deadline_past")
        else if (l.deadline > now + MAX_LOCK_HORIZON + CLOCK_RESERVE) Refused("deadline_too_far")
        else if (l.amount > room(b, l.payer)) Refused("insufficient_capacity")
        else Ok(withLock(b, l.id, { on: true, payer: l.payer, amount: l.amount, hashlock: l.hashlock, deadline: l.deadline }))
    | HtlcResolve(r) =>
        if (not(LOCK_SLOTS.contains(r.id))) Refused("bad_slot")
        else if (not(b.locks.get(r.id).on)) Refused("no_such_lock")
        else {
          val l = b.locks.get(r.id)
          if (payee(l) != author) Refused("not_payee")
          else if (hashOf(r.secret) != l.hashlock) Refused("wrong_secret")
          else if (now > l.deadline) Refused("past_deadline")
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
        else if (now <= b.locks.get(r.id).deadline + CLOCK_RESERVE) Refused("not_expired")
        else Ok(withLock(b, r.id, NO_LOCK))
  }

  // A frame is all-or-nothing on the receiving side: the first refused tx refuses the frame [Q-E2, R-X1].
  pure def replay(b: Body, txs: List[Tx], author: Side, now: int): Res =
    txs.foldl(Ok(b), (acc, tx) => match acc {
      | Ok(cur) => applyTx(cur, tx, author, now)
      | Refused(why) => Refused(why)
    })

  // The proposer keeps only the txs that still apply, in order. A tx that no longer applies is never halted on and never lost: it comes back in
  // `dropped`, and the caller refuses it with notice [R-NOTICE].
  pure def keepValid(b: Body, txs: List[Tx], author: Side, now: int): { body: Body, txs: List[Tx], dropped: List[Tx] } =
    txs.foldl({ body: b, txs: List(), dropped: List() }, (acc, tx) => match applyTx(acc.body, tx, author, now) {
      | Ok(nx) => { ...acc, body: nx, txs: acc.txs.append(tx) }
      | Refused(_) => { ...acc, dropped: acc.dropped.append(tx) }
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
  pure val NO_FRAME: Frame = { height: 0, parent: 0, nonce: 0, ts: 0, author: Left, txs: List(), after: GENESIS }

  pure val EMPTY_REPLICA: Replica =
    { height: 0, refused: List(), submitted: 0, done: 0, pnonce: 0, tip: GENESIS, lastFid: 0, status: Open, mempool: List() }

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

  // A frame the receiver accepts: the next height, and replaying on its own tip, at its own clock, to the claimed state. The frame's
  // timestamp is not read: a frame is never refused for its age (a signed frame refused without an exit deadlocks the Account: exact
  // retransmission must stay available after an arbitrary outage) or for its date, and no time rule trusts it [R-CLOCK].
  pure def acceptable(r: Replica, now: int, f: Frame, self: Side): bool = and {
    f.author != self,
    f.parent == r.lastFid,                                 // R-PARENT: it extends the frame I committed last (the wire's parent hash)
    f.height == r.height + 1,
    f.nonce > r.pnonce,                                    // N1: a proof nonce above the last one, or the chain would refuse a start with it
    f.nonce <= r.pnonce + 1 + MAX_NONCE_GAP,               // and not a leap that burns the counter
    match replay(r.tip, f.txs, f.author, now) {
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
  pure def frameToPropose(r: Replica, now: int, s: Side, gap: int): Frame = {
    val sel = keepValid(r.tip, r.mempool, s, now)
    { height: r.height + 1, parent: r.lastFid, nonce: r.pnonce + 1 + gap, ts: now, author: s, txs: sel.txs, after: sel.body }
  }

  pure def canPropose(r: Replica, now: int, s: Side): bool = and {
    isOpen(r),
    r.height < MAX_HEIGHT,
    frameToPropose(r, now, s, 0).txs.length() > 0
  }

  pure def sigKey(signer: Side, f: Frame): SigKey = (signer, f.nonce, f.author == Left)

  // What a receiver does with a Propose. In order:
  //   1. it extends our tip and we are Open -> hold it for our ack.
  //   2. it is the frame we last committed (our ack was lost) -> send the same ack again (idempotent), in ANY state: a replica that has
  //      already proposed its own next frame still re-acks, or one lost ack deadlocks both sides [R-REACK].
  //   3. we also proposed at this height (collision): Left keeps its frame and ignores Right's;
  //      Right discards its own frame, puts its txs back in the mempool, and takes Left's [R-A1].
  //   4. anything else is stale, from the future, or refused: dropped and counted.
  type Outcome = { r: Replica, ack: bool, rolled: bool, refused: bool }

  pure def repeatOfLast(r: Replica, fid: int): bool = r.lastFid != 0 and r.lastFid == fid

  pure def onPropose(r: Replica, now: int, s: Side, fid: int, f: Frame, own: Frame): Outcome = {
    val keep: Outcome = { r: r, ack: false, rolled: false, refused: false }
    val refuse: Outcome = { ...keep, refused: true }
    if (repeatOfLast(r, fid)) { ...keep, ack: true }
    else match r.status {
      | Open =>
          if (acceptable(r, now, f, s)) { ...keep, r: { ...r, status: Received(fid) } }
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
  pure def commit(r: Replica, self: Side, fid: int, f: Frame): Replica =
    { ...r, height: f.height, pnonce: f.nonce, tip: f.after, lastFid: fid, status: Open,
      done: r.done + (if (f.author == self) f.txs.length() else 0) }

}
