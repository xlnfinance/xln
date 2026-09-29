// XLN J layer for one Account and one token: the Depository as the two parties see it.
//
// What this module owns
//   - On-chain facts about an Account: reserves, collateral, ondelta, the stored nonce, the ondelta epoch, debt,
//     the public secret registry, and one active dispute.
//   - The dispute game: start, counter, finalize (three paths), and the payout of the settled proof.
//   - Two honest-party behaviours the game is designed around: answer a dispute inside the window, and publish a
//     secret the moment it is known.
//
// What it does not own: how a proof came to be signed (account.qnt), how an Entity decides to act (entity.qnt).
// Signed proofs enter as an arena of records chosen at the start of the run (`arena`), shaped like an honest Account
// history: both-signed states at nonces 1..k, an unacked proposal at k+1, a rolled-back Right proposal at k, and the
// same again for the epoch after a finalize. The chain rules then decide which of them can settle.
//
// It describes the FIXED contracts (plan/contracts-decisions.md): C1 proofs bind the ondelta epoch, C2 batch
// authority is per entity (not visible in a one-Account model), H1 finalize waits for an open HTLC deadline unless
// the secret is public, H2 both response windows have a floor. H3 (retired boards) is not modelled: it needs
// board rotation, which lives in entity.qnt.
//
// Time is in ticks (1 tick = the response-window floor, 60 s on testnet). "Batch" atomicity: each action below is one
// operation of one batch; a batch that reverts leaves no trace, which is the same as the action being disabled.
// N2 (relay): finalizes are submitted per Account, never bundled, because one open deadline reverts a whole batch.

module chain {
  // ---------------------------------------------------------------------------------------------------------
  // Parameters
  // ---------------------------------------------------------------------------------------------------------

  pure val MAXT = 6              // the clock runs 1..MAXT+1; 0 means "never" in registry and knows
  pure val MIN_WINDOW = 1        // H2: each response window, in ticks
  pure val NONCE_TOP = 3         // the highest committed nonce of epoch 0
  pure val SECRET = 1            // the one secret; every clause's hashlock is its hash
  pure val RESERVE_MAX = 2       // initial reserve of each side

  // ---------------------------------------------------------------------------------------------------------
  // Domain model
  // ---------------------------------------------------------------------------------------------------------

  type Side = | Left | Right
  pure def other(s: Side): Side = match s { | Left => Right | Right => Left }
  pure val SIDES = Set(Left, Right)
  pure def isLeft(s: Side): bool = match s { | Left => true | Right => false }

  // A clause in a proof body: `payer` owes `amount` to the other side if the secret is shown by `deadline`.
  // DeltaTransformer.Payment{amount, revealedUntilTimestamp, hash}; the sign is the payer's side.
  type Clause = { on: bool, payer: Side, amount: int, deadline: int }

  // A dispute proof a party signed: what the chain checks (Types.sol ProofBody + the signed hash fields).
  //   epoch, nonce, leftAuthored   are inside the signed hash (HankoEncoding.sol:36, C1)
  //   offdelta, clause, windows    are the ProofBody
  //   sigL, sigR                   who signed it (the author always did; both if the frame was acked)
  type SignedProof = {
    live: bool, nonce: int, epoch: int, leftAuthored: bool,
    offdelta: int, clause: Clause, wl: int, wr: int, sigL: bool, sigR: bool
  }

  // Equal nonces are ordered by author: Left wins (Types.sol equal-nonce rule, R-A1).
  pure def rank(r: SignedProof): int = r.nonce * 2 + (if (r.leftAuthored) 1 else 0)
  pure def signedBy(r: SignedProof, s: Side): bool = match s { | Left => r.sigL | Right => r.sigR }
  pure def both(r: SignedProof): bool = r.sigL and r.sigR

  // One active dispute (AccountInfo dispute* fields).
  type Dispute = {
    on: bool, starter: Side,
    rec0: int,                // arena id of the initial proof
    t0: int, timeout: int,    // start time, and start + both windows
    wl: int, wr: int,         // windows frozen from the initial proof
    initArgs: bool,           // the starter revealed the secret in its start arguments (frozen at start)
    counter: int,             // arena id of the registered counter-proof (0 = none)
    counterBranch: int,       // the one newer branch the starter named at start, with its own arguments
    counterArgs: bool
  }

  // via: the cooperative update that opened the current epoch (0 = none: the epoch was opened by a finalize, or is the first).
  type Acct = { nonce: int, epoch: int, coll: int, ondelta: int, via: int }

  // Ghost flags: set at the moment a rule is broken, so each property is one boolean.
  type Ghost = {
    badApply: bool,       // a proof settled that P1 does not allow
    clauseMiss: bool,     // an honest payee that learned the secret in time was not paid
    nonceBack: bool,      // the stored nonce went down
    appliedTwice: bool,   // one arena record settled twice
    freeDebt: bool,       // debt was booked while its debtor still had spendable reserve
    xWasOffline: bool,    // the honest party was offline while a dispute was active (then it may lose)
    finalizes: int,
    lastApplied: int
  }

  pure val NO_CLAUSE: Clause = { on: false, payer: Left, amount: 0, deadline: 0 }
  pure val NO_PROOF: SignedProof = {
    live: false, nonce: 0, epoch: 0, leftAuthored: false, offdelta: 0, clause: NO_CLAUSE, wl: 0, wr: 0,
    sigL: false, sigR: false
  }
  pure val NO_DISPUTE: Dispute = {
    on: false, starter: Left, rec0: 0, t0: 0, timeout: 0, wl: 0, wr: 0, initArgs: false,
    counter: 0, counterBranch: 0, counterArgs: false
  }

  // ---------------------------------------------------------------------------------------------------------
  // What a proof settles to. Depository._applyAccountDelta and _settleShortfall.
  // ---------------------------------------------------------------------------------------------------------

  pure def imin(a: int, b: int): int = if (a < b) a else b
  pure def imax(a: int, b: int): int = if (a > b) a else b

  type Money = { res: Side -> int, debt: Side -> int }   // debt[s] is what s owes to the other side

  // Debt is a lazy claim on future inflows: nothing is paid when reserve arrives, it is paid by `enforce`, which runs
  // before every outflow (Depository._enforceDebts before R2R, R2C, R2E and _settleShortfall). Spendable reserve is
  // reserve net of outstanding debt (_spendableReserve).
  pure def spendable(m: Money, s: Side): int = imax(0, m.res.get(s) - m.debt.get(s))

  pure def enforce(m: Money, debtor: Side): Money = {
    val c = other(debtor)
    val d1 = imin(m.debt.get(debtor), m.res.get(debtor))
    {
      res: m.res.set(debtor, m.res.get(debtor) - d1).set(c, m.res.get(c) + d1),
      debt: m.debt.set(debtor, m.debt.get(debtor) - d1)
    }
  }

  // The debtor pays what it can from spendable reserve after enforcement; the rest becomes debt (_settleShortfall).
  pure def shortfall(m0: Money, debtor: Side, amount: int): Money = {
    val c = other(debtor)
    val m = enforce(m0, debtor)
    val pay = imin(amount, spendable(m, debtor))
    {
      res: m.res.set(debtor, m.res.get(debtor) - pay).set(c, m.res.get(c) + pay),
      debt: m.debt.set(debtor, m.debt.get(debtor) + (amount - pay))
    }
  }

  // Δ = ondelta + offdelta is Left's allocation. Δ <= 0: Right takes the collateral and Left owes -Δ.
  // 0 < Δ < c: split. Δ >= c: Left takes the collateral and Right owes Δ - c.
  pure def payout(m: Money, coll: int, d: int): Money =
    if (d <= 0) {
      val m1 = { res: m.res.set(Right, m.res.get(Right) + coll), debt: m.debt }
      if (d == 0) m1 else shortfall(m1, Left, -d)
    } else if (d >= coll) {
      val m1 = { res: m.res.set(Left, m.res.get(Left) + coll), debt: m.debt }
      if (d == coll) m1 else shortfall(m1, Right, d - coll)
    } else {
      { res: m.res.set(Left, m.res.get(Left) + d).set(Right, m.res.get(Right) + (coll - d)), debt: m.debt }
    }

  // The side that owes when Δ leaves the collateral range (Left below 0, Right above the collateral is decided by the caller).
  pure def debtorOf(d: int): Side = if (d <= 0) Left else Right

  // The offdelta a proof settles to once the clause is resolved. A revealed clause moves offdelta by its amount
  // towards the payee: a Left payer makes it smaller, a Right payer larger.
  pure def settledOffdelta(r: SignedProof, revealed: bool): int =
    if (r.clause.on and revealed)
      (match r.clause.payer { | Left => r.offdelta - r.clause.amount | Right => r.offdelta + r.clause.amount })
    else r.offdelta

  // ---------------------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------------------

  var arena: int -> SignedProof              // every signed proof that exists (slot 0 = none); fixed at init
  var honest: Side                   // the party that follows the protocol; the other one is the adversary
  var now: int
  var acct: Acct
  var money: Money
  var total: int                     // reserves + collateral: constant, there are no outside deposits here
  var dispute: Dispute
  var registry: int                  // time the secret was published on chain (0 = not published)
  var knows: Side -> int             // time each side learned the secret (0 = does not know it)
  var offline: bool                  // the honest party is offline right now
  var applied: int -> bool           // arena records that have settled
  var ghost: Ghost

  pure val NREC = 12
  pure val RECS = 1.to(NREC)
  pure val SLOTS = 0.to(NREC)     // slot 0 is the empty proof: "no proof" is a valid lookup

  pure def mkProof(live: bool, nonce: int, epoch: int, la: bool, off: int, c: Clause, sigL: bool, sigR: bool): SignedProof =
    { live: live, nonce: nonce, epoch: epoch, leftAuthored: la, offdelta: off, clause: c,
      wl: MIN_WINDOW, wr: MIN_WINDOW, sigL: sigL, sigR: sigR }

  // An honest history, chosen nondeterministically. Slots:
  //   1..3  both-signed states at nonces 1..k of epoch 0 (k = tip)
  //   4     an unacked proposal at k+1, signed only by its author
  //   5     a Right proposal at nonce k that lost a collision to the Left-authored tip: signed only by Right
  //   6     the both-signed baseline of epoch 1 (after any finalize), at a nonce above anything the chain can hold
  //   7     an unacked proposal of epoch 1
  action init = {
    nondet k = 1.to(NONCE_TOP).oneOf()
    nondet la1 = Set(true, false).oneOf()
    nondet la2 = Set(true, false).oneOf()
    nondet la3 = Set(true, false).oneOf()
    nondet o1 = (-3).to(3).oneOf()
    nondet o2 = (-3).to(3).oneOf()
    nondet o3 = (-3).to(3).oneOf()
    nondet cOn = Set(true, false).oneOf()
    nondet cPayer = SIDES.oneOf()
    nondet cAmt = 1.to(2).oneOf()
    nondet cDl = 1.to(MAXT).oneOf()
    nondet pendLive = Set(true, false).oneOf()
    nondet pendAuthor = SIDES.oneOf()
    nondet pendOff = (-3).to(3).oneOf()
    nondet shadowLive = Set(true, false).oneOf()
    nondet shadowOff = (-3).to(3).oneOf()
    nondet baseOff = (-1).to(1).oneOf()
    nondet baseLa = Set(true, false).oneOf()
    nondet pend2Live = Set(true, false).oneOf()
    nondet pend2Author = SIDES.oneOf()
    nondet pend2Off = (-1).to(1).oneOf()
    nondet hon = SIDES.oneOf()
    nondet resL = 0.to(RESERVE_MAX).oneOf()
    nondet resR = 0.to(RESERVE_MAX).oneOf()
    nondet coll = 0.to(2).oneOf()
    // the clause, if any, rides in the tip and in the pending proposal (the same lock, still open)
    val clause: Clause = { on: cOn, payer: cPayer, amount: cAmt, deadline: cDl }
    val tipLeft = if (k == 1) la1 else if (k == 2) la2 else la3
    initFrom(
      Map(
        0 -> NO_PROOF,
        1 -> mkProof(k >= 1, 1, 0, la1, o1, if (k == 1) clause else NO_CLAUSE, true, true),
        2 -> mkProof(k >= 2, 2, 0, la2, o2, if (k == 2) clause else NO_CLAUSE, true, true),
        3 -> mkProof(k >= 3, 3, 0, la3, o3, if (k == 3) clause else NO_CLAUSE, true, true),
        4 -> mkProof(pendLive, k + 1, 0, isLeft(pendAuthor), pendOff, clause, isLeft(pendAuthor), not(isLeft(pendAuthor))),
        5 -> mkProof(shadowLive and tipLeft, k, 0, false, shadowOff, clause, false, true),
        6 -> mkProof(true, 6, 1, baseLa, baseOff, NO_CLAUSE, true, true),
        7 -> mkProof(pend2Live, 7, 1, isLeft(pend2Author), pend2Off, NO_CLAUSE, isLeft(pend2Author), not(isLeft(pend2Author)))
      ),
      hon, resL, resR, coll
    )
  }

  // The state before anything happened, for a given arena: scenario tests start here with a hand-made history.
  action initFrom(ar: int -> SignedProof, hon: Side, resL: int, resR: int, coll: int): bool = all {
    arena' = SLOTS.mapBy(i => if (ar.keys().contains(i)) ar.get(i) else NO_PROOF),      // slots a history does not use stay empty
    honest' = hon,
    now' = 1,
    acct' = { nonce: 0, epoch: 0, coll: coll, ondelta: 0, via: 0 },
    money' = { res: Map(Left -> resL, Right -> resR), debt: Map(Left -> 0, Right -> 0) },
    total' = resL + resR + coll,
    dispute' = NO_DISPUTE,
    registry' = 0,
    knows' = Map(Left -> 0, Right -> 0),
    offline' = false,
    applied' = SLOTS.mapBy(_ => false),
    ghost' = { badApply: false, clauseMiss: false, nonceBack: false, appliedTwice: false, freeDebt: false,
               xWasOffline: false, finalizes: 0, lastApplied: 0 }
  }

  // ---------------------------------------------------------------------------------------------------------
  // P1: what may settle. The honest party's belief is the both-signed proof of the current epoch with the
  // highest (nonce, Left-wins) rank. It has also signed, and so consented to, any newer proof of its own.
  // ---------------------------------------------------------------------------------------------------------

  pure def tipRank(ar: int -> SignedProof, e: int): int =
    RECS.fold(0, (m, i) => if (ar.get(i).live and ar.get(i).epoch == e and both(ar.get(i))) imax(m, rank(ar.get(i))) else m)

  pure def allowed(ar: int -> SignedProof, e: int, x: Side, rid: int): bool = {
    val r = ar.get(rid)
    and {
      r.live, r.epoch == e,
      or {
        both(r) and rank(r) == tipRank(ar, e),
        signedBy(r, x) and not(both(r)) and rank(r) > tipRank(ar, e)
      }
    }
  }

  // The tip the honest party would use: the highest both-signed proof of the epoch.
  pure def tipId(ar: int -> SignedProof, e: int): int =
    RECS.fold(0, (m, i) =>
      if (ar.get(i).live and ar.get(i).epoch == e and both(ar.get(i)) and rank(ar.get(i)) == tipRank(ar, e)) i else m)

  // ---------------------------------------------------------------------------------------------------------
  // Chain operations. Each guard is the contract's revert condition.
  // ---------------------------------------------------------------------------------------------------------

  pure def windowsOk(r: SignedProof): bool = r.wl >= MIN_WINDOW and r.wr >= MIN_WINDOW        // H2

  // disputeStart: `s` starts with proof `rid`, which the counterparty must have signed.
  pure def canStart(w: { ar: int -> SignedProof, a: Acct, d: Dispute }, s: Side, rid: int): bool = {
    val r = w.ar.get(rid)
    and {
      rid >= 1, r.live,
      not(w.d.on),
      r.nonce > w.a.nonce,
      r.epoch == w.a.epoch,             // C1
      signedBy(r, other(s)),
      windowsOk(r)
    }
  }

  // The secret evidence the settled proof is judged by: public registry, the starter's frozen arguments, and the
  // non-starter's arguments at finalize time (Depository/DeltaTransformer.applyPayment).
  pure def revealedBy(r: SignedProof, reg: int, now: int, d: Dispute, starterArgs: bool, otherArgs: bool): bool = or {
    reg != 0 and reg <= r.clause.deadline,
    starterArgs and d.t0 <= r.clause.deadline,
    otherArgs and now <= r.clause.deadline
  }

  // ---------------------------------------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------------------------------------

  // The honest party must get to act before the clock passes an instant at which the adversary could otherwise
  // finalize a stale proof. Modelled as urgency: time does not advance while an honest response is enabled and the
  // honest party is online. If it is offline, time advances and it may lose (ghost.xWasOffline records that).
  pure def honestCounterId(ar: int -> SignedProof, a: Acct, d: Dispute, x: Side): int = {
    val t = tipId(ar, a.epoch)
    val r = ar.get(t)
    if (t != 0 and d.on and d.starter != x and signedBy(r, d.starter) and r.epoch == a.epoch
        and rank(r) > rank(ar.get(d.rec0))
        and (d.counter == 0 or rank(r) > rank(ar.get(d.counter)))) t
    else 0
  }

  pure def payeeOf(c: Clause): Side = other(c.payer)

  // A secret the honest party publishes the moment it knows it: nobody has, and some live proof of this epoch has an open
  // clause it is the payee of. (Publishing costs a transaction; an implementation may wait until a counterparty stalls, at the
  // price of the deadline tolerance: `d` below is the whole tolerance, zero here.)
  pure def honestCanPublish(ar: int -> SignedProof, a: Acct, d: Dispute, x: Side, k: Side -> int, reg: int, now: int): bool = and {
    k.get(x) != 0, reg == 0,
    RECS.exists(i => and {
      ar.get(i).live, ar.get(i).epoch == a.epoch, ar.get(i).clause.on,
      payeeOf(ar.get(i).clause) == x, ar.get(i).clause.deadline >= now
    })
  }

  // The honest party has something it must do before time passes.
  val respondDue: bool = or {
    honestCounterId(arena, acct, dispute, honest) != 0,
    honestCanPublish(arena, acct, dispute, honest, knows, registry, now)
  }

  val urgent: bool = not(offline) and respondDue

  action tick: bool = all {
    now <= MAXT,
    not(urgent),
    now' = now + 1,
    // a tick that passes while the honest party is offline and owed a response is the one way it may lose
    ghost' = { ...ghost, xWasOffline: ghost.xWasOffline or (offline and respondDue) },
    arena' = arena, honest' = honest, acct' = acct, money' = money, total' = total, dispute' = dispute,
    registry' = registry, knows' = knows, offline' = offline, applied' = applied
  }

  // A side learns the secret (from downstream, from the payer, ...).
  action learn(s: Side): bool = all {
    knows.get(s) == 0,
    knows' = knows.set(s, now),              // the clock starts at 1, so 0 stays "unknown"
    arena' = arena, honest' = honest, now' = now, acct' = acct, money' = money, total' = total,
    dispute' = dispute, registry' = registry, offline' = offline, applied' = applied, ghost' = ghost
  }

  // Anyone who knows the secret can publish it (SecretReveal; Depository processBatch revealSecrets).
  action publish(s: Side): bool = all {
    knows.get(s) != 0,
    registry == 0,
    registry' = now,
    arena' = arena, honest' = honest, now' = now, acct' = acct, money' = money, total' = total,
    dispute' = dispute, knows' = knows, offline' = offline, applied' = applied, ghost' = ghost
  }

  action setOffline(b: bool): bool = all {
    offline' = b,
    arena' = arena, honest' = honest, now' = now, acct' = acct, money' = money, total' = total,
    dispute' = dispute, registry' = registry, knows' = knows, applied' = applied, ghost' = ghost
  }

  // R2C: `s` moves its own reserve into the Account's collateral, crediting `rcv` (Account.sol processR2C: the receiving
  // entity need not be the payer). Crediting Left also raises ondelta, so Left's allocation grows by the amount; crediting
  // Right raises only the collateral, which is Right's allocation. The contract does not block it during a dispute,
  // and it does not advance the epoch (no signature is involved), so every signed proof stays valid.
  action r2c(s: Side, rcv: Side, amt: int): bool = all {
    amt >= 1, spendable(enforce(money, s), s) >= amt,
    money' = { ...enforce(money, s), res: enforce(money, s).res.set(s, enforce(money, s).res.get(s) - amt) },
    acct' = { ...acct, coll: acct.coll + amt, ondelta: acct.ondelta + (if (isLeft(rcv)) amt else 0) },
    arena' = arena, honest' = honest, now' = now, total' = total, dispute' = dispute, registry' = registry,
    knows' = knows, offline' = offline, applied' = applied, ghost' = ghost
  }

  // disputeStart. The stored nonce becomes the proof's nonce. The starter freezes its arguments now: whether it
  // reveals the secret, and, for one named newer branch, its arguments for that branch.
  action startWith(s: Side, rid: int, initArgs: bool, branch: int, counterArgs: bool): bool = all {
    canStart({ ar: arena, a: acct, d: dispute }, s, rid),
    initArgs implies knows.get(s) != 0,
    counterArgs implies knows.get(s) != 0,
    branch == 0 or (arena.get(branch).live and rank(arena.get(branch)) > rank(arena.get(rid))),
    dispute' = {
      on: true, starter: s, rec0: rid, t0: now, timeout: now + arena.get(rid).wl + arena.get(rid).wr,
      wl: arena.get(rid).wl, wr: arena.get(rid).wr,
      initArgs: initArgs, counter: 0, counterBranch: branch, counterArgs: counterArgs
    },
    acct' = { ...acct, nonce: arena.get(rid).nonce },
    ghost' = { ...ghost, nonceBack: ghost.nonceBack or arena.get(rid).nonce < acct.nonce },
    arena' = arena, honest' = honest, now' = now, money' = money, total' = total, registry' = registry,
    knows' = knows, offline' = offline, applied' = applied
  }

  action adversaryStart: bool = {
    nondet rid = RECS.oneOf()
    nondet initArgs = Set(true, false).oneOf()
    nondet branch = 0.to(NREC).oneOf()
    nondet cArgs = Set(true, false).oneOf()
    startWith(other(honest), rid, initArgs, branch, cArgs)
  }

  // The honest party starts with its tip and reveals every secret it knows (R-P3: a dispute start carries every
  // secret the starter knows for the locks in its proof).
  action honestStart: bool = all {
    not(offline),
    tipId(arena, acct.epoch) != 0,
    startWith(honest, tipId(arena, acct.epoch), knows.get(honest) != 0, 0, false)
  }

  // counter: the non-starter registers a newer state before T. An equal nonce is replaced only by a Left-authored
  // proof over a Right-authored one, which is exactly a higher rank.
  action counterWith(s: Side, rid: int): bool = {
    val r = arena.get(rid)
    all {
      dispute.on, dispute.starter != s,
      now < dispute.timeout,
      rid >= 1, r.live,
      r.epoch == acct.epoch,                         // C1
      r.wl == dispute.wl, r.wr == dispute.wr,        // N3: one set of windows per Account
      signedBy(r, dispute.starter),
      rank(r) > rank(arena.get(dispute.rec0)),
      dispute.counter == 0 or rank(r) > rank(arena.get(dispute.counter)),
      dispute' = { ...dispute, counter: rid },
      arena' = arena, honest' = honest, now' = now, acct' = acct, money' = money, total' = total,
      registry' = registry, knows' = knows, offline' = offline, applied' = applied, ghost' = ghost
    }
  }

  action adversaryCounter: bool = { nondet rid = RECS.oneOf() counterWith(other(honest), rid) }

  action honestCounter: bool = all {
    not(offline),
    honestCounterId(arena, acct, dispute, honest) != 0,
    counterWith(honest, honestCounterId(arena, acct, dispute, honest))
  }

  // finalize. Paths: 0 the initial proof, 1 the registered counter-proof, 2 a newer signed proof presented by the
  // non-starter that closes at once. `otherArgs` is the finalizer's own secret evidence (non-starter only).
  action finalizeWith(f: Side, path: int, rid: int, otherArgs: bool): bool = {
    val hasCounter = dispute.counter != 0
    val useId = if (path == 0) dispute.rec0 else if (path == 1) dispute.counter else rid
    val r = arena.get(useId)
    val isNonStarter = f != dispute.starter
    val branchArgs = dispute.counterArgs and useId == dispute.counterBranch
    val starterArgs = if (path == 0) dispute.initArgs else branchArgs
    val revealed = revealedBy(r, registry, now, dispute, starterArgs, otherArgs)
    val d = acct.ondelta + settledOffdelta(r, revealed)
    val m2 = payout(money, acct.coll, d)
    val adopts = path != 0
    val newNonce = if (adopts) r.nonce else acct.nonce + 1
    all {
      dispute.on,
      useId >= 1, r.live,
      otherArgs implies (isNonStarter and knows.get(f) != 0),
      // the three paths' own conditions
      if (path == 0) and { not(hasCounter), now >= dispute.timeout or isNonStarter }
      else if (path == 1) and { hasCounter, now >= dispute.timeout }
      else and {
        not(hasCounter), isNonStarter, r.epoch == acct.epoch,
        r.wl == dispute.wl, r.wr == dispute.wr,
        signedBy(r, dispute.starter),
        rank(r) > rank(arena.get(dispute.rec0))
      },
      // H1: an unrevealed clause whose deadline is still open makes finalize revert
      not(r.clause.on and not(revealed) and now <= r.clause.deadline),
      money' = m2,
      acct' = { nonce: newNonce, epoch: acct.epoch + 1, coll: 0, ondelta: 0, via: 0 },     // C1: finalize advances the epoch
      dispute' = NO_DISPUTE,
      applied' = applied.set(useId, true),
      ghost' = {
        badApply: ghost.badApply or (not(allowed(arena, acct.epoch, honest, useId)) and not(ghost.xWasOffline)),
        clauseMiss: ghost.clauseMiss or and {
          r.clause.on, payeeOf(r.clause) == honest, knows.get(honest) != 0, knows.get(honest) <= r.clause.deadline,
          not(ghost.xWasOffline), not(revealed)
        },
        nonceBack: ghost.nonceBack or newNonce < acct.nonce,
        appliedTwice: ghost.appliedTwice or applied.get(useId),
        freeDebt: ghost.freeDebt or ((d < 0 or d > acct.coll) and m2.debt.get(debtorOf(d)) > 0 and spendable(m2, debtorOf(d)) > 0),
        xWasOffline: ghost.xWasOffline,
        finalizes: ghost.finalizes + 1,
        lastApplied: useId
      },
      arena' = arena, honest' = honest, now' = now, total' = total, registry' = registry, knows' = knows,
      offline' = offline
    }
  }

  action adversaryFinalize: bool = {
    nondet path = 0.to(2).oneOf()
    nondet rid = RECS.oneOf()
    nondet oa = Set(true, false).oneOf()
    finalizeWith(other(honest), path, rid, oa)
  }

  // The honest party closes when it can: the counter-proof if one is registered, else the initial proof, carrying
  // every secret it knows if it is the non-starter.
  // It never closes on a proof it does not stand behind: with a stale initial proof it registers the counter first.
  action honestFinalize: bool = all {
    not(offline),
    dispute.on,
    allowed(arena, acct.epoch, honest, if (dispute.counter != 0) dispute.counter else dispute.rec0),
    finalizeWith(honest, if (dispute.counter != 0) 1 else 0, 0, dispute.starter != honest and knows.get(honest) != 0)
  }

  action step = any {
    tick,
    learn(Left), learn(Right),
    publish(Left), publish(Right),
    setOffline(true), setOffline(false),
    { nondet a = 1.to(2).oneOf() nondet who = SIDES.oneOf() nondet rcv = SIDES.oneOf() r2c(who, rcv, a) },
    adversaryStart, honestStart,
    adversaryCounter, honestCounter,
    adversaryFinalize, honestFinalize
  }

  // ---------------------------------------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------------------------------------

  // P1 enforceable: every proof that settles is one the honest party consented to or holds as its own latest state, of
  // the epoch the chain is in, unless the honest party was offline during the dispute.
  val p1_allowed: bool = not(ghost.badApply)

  // P1 for clauses: an honest payee that learned the secret before the deadline is paid, unless it was offline.
  val p1_clause: bool = not(ghost.clauseMiss)

  // P3 conserving: reserves plus collateral never change except by the deposits made at init.
  val p3_conserved: bool = money.res.get(Left) + money.res.get(Right) + acct.coll == total

  // The stored nonce never goes down, and no arena record settles twice.
  val nonce_monotone: bool = not(ghost.nonceBack)
  val no_double_settle: bool = not(ghost.appliedTwice)

  // Debt is only what a payout could not cover: it is never booked while the debtor could still pay.
  val debt_only_when_broke: bool = not(ghost.freeDebt)

  val safe: bool = and { p1_allowed, p1_clause, p3_conserved, nonce_monotone, no_double_settle, debt_only_when_broke }

  // Coverage witnesses: false on purpose, each must be violated by some trace.
  val w_no_dispute: bool = not(dispute.on)
  val w_no_finalize: bool = ghost.finalizes == 0
  val w_no_two_finalizes: bool = ghost.finalizes < 2
  val w_no_counter: bool = dispute.counter == 0
  val w_no_debt: bool = money.debt.get(Left) == 0 and money.debt.get(Right) == 0
  val w_no_clause_settled: bool = not(ghost.finalizes > 0 and arena.get(ghost.lastApplied).clause.on)
  // the exclusion for an absent honest party is not vacuous: some run settles a proof the honest party did not stand behind
  val w_offline_can_lose: bool = not(ghost.xWasOffline and ghost.finalizes > 0 and not(allowed(arena, acct.epoch - 1, honest, ghost.lastApplied)))
}
