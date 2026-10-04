// HTLC holds across a dispute, on a route of two Accounts: the payer P -- U -- the hub H -- D -- the payee Y.
//
// WHY THIS FILE EXISTS. dispute.qnt leaves out money and holds. The coordinator's audit of the freeze PR (#162, review/pr-162/REVIEW-A.md F1, F2)
// found two ways a routing node loses the routed amount once the downstream Account is in a dispute:
//   F1  the payee, frozen on D, reveals the secret on the chain, the only way left to be paid. The hub learns a secret only from a
//       peer frame it accepted (pure/entity/frame.ts takenFrom) and the watcher ignores SecretRevealed (pure/j/log.ts IGNORED), so the
//       hub never claims upstream. The chain pays Y on D, the lock on U expires, P is refunded: the hub paid and did not collect.
//   F2  a release queued while the Account was quiet is committed after the finalize, in the new epoch, because the rebase keeps holds
//       (pure/account/state.ts). The chain already paid the hold when it finalized the proof that carried it: Y is paid twice.
// One payment of one unit: P locks it on U for H (deadline TU), H locks it on D for Y (deadline TD = TU - HOP).
//
// PROPERTY (the coordinator's): a routing node never pays out more than it collects for one payment.
//   paid_once   what Y was paid, by a frame or by the chain, is at most one unit
//   route_safe  once the lock on U is closed (claimed by H or expired to P), H paid out at most what it collected
//
// SEVEN SWITCHES (the first two the decided fixes of #162/#165, ARGS and HIDE are #167, the rest the reveal registry and the clock, #173):
//   SEE       a secret revealed on the chain is a chain fact, heard at depth (D9) like any J event; the hub's paybook learns it as it learns
//             a received resolve, and claims upstream
//   DISSOLVE  a hold carried by the proof a finalize settled is dissolved at the epoch move, at both sides, never re-released
//   ARGS      a secret shown in a dispute's arguments pays the clause (DeltaTransformer applyPayment) with no SecretRevealed; the hub's watcher
//             reads it from the start's log data and from the input of the finalize (R-WATCH-CALLDATA), and the hub claims upstream
//   HIDE      the payee finalizes where the watcher cannot read it: through a contract that relays the signed batch, or by calling
//             Depository.watchtowerCounterDispute directly (a second selector; at or after T it finalizes with the caller's own otherArguments).
//             The watcher decodes the processBatch selector only, finds no finalize op, and tells finalize_unread, no secret. A finalize
//             before TD pays the clause, the hub cannot claim: the hub is out one unit
//   XREV      the payee reveals the secret by calling DeltaTransformer.revealSecret itself (public, unauthenticated: DeltaTransformer.sol 404-415).
//             It sets the registry the clause is paid from (applyPayment, hashToTimestamp) and emits the transformer's own SecretRevealed,
//             not the Depository's: a node that watches Depository logs only (host/shell/evm/watch.ts filters `address === depository`) hears nothing
//   TSEE      the hub's watcher also reads the transformer's SecretRevealed, at depth like any J event (D9)
//   BACK      the backstop: the hub co-signs the upstream lock's expiry only after the registry, read at depth, shows no reveal by the lock's
//             timestamp deadline; when it does, the hub claims on U by the registry (the contract pays the clause from it)
//   SLK       the contract counts time in seconds, the hub's gates count J heights; the signed second of a deadline is a line through an anchor plus
//             a slack (R-DEADLINE-TIMESTAMP), so a reveal up to SLK ticks after the height deadline still pays. PD: the hub hears an event this
//             many ticks after it landed (depth plus poll). RSV: the reserve an expiry waits for after the deadline. CHAIN: the hub's claim on U is
//             a chain claim, which the contract accepts until the lock's second (TU + SLK), and not a frame the height gate refuses after TU
//   (ARGS is also only as good as the decode: the chain reads a finalize's argument blob as bytes[], one Arguments per clause; a reader that
//   takes it for one Arguments learns nothing, and the code is then the `noargs` variant.)
// The model is the code of #162 (FREEZE on): an Entity with a dispute record seals nothing and refuses the peer's frames. The code before
// the freeze is dispute.qnt's `today` row, whose payee loses (no_silent_zeroing); here the hub is the subject.
//
// WHAT IS ABSTRACTED. One dispute, from one proof that carries the hold if the starter still saw it open (`carried`). The chain pays a
// carried hold to Y iff the secret was registered by TD (E6, H1: a finalize over an open clause waits for TD), else refunds it to H.
// A finalize may land from the end of the window (and from TD for a carried hold), within LAG of becoming possible. No crash, no counter,
// no stale proof: dispute.qnt's. The payer P is adversarial: it lets its lock expire at TU (the time of expiry has no reserve here). A frame
// commits on the receiver and on the sender at one step each (receive, ack); a frame of another epoch is refused.

module htlc {
  const SEE: bool
  const DISSOLVE: bool
  const HIDE: bool              // the payee can finalize through a call the watcher cannot decode (the code of #167 reads a direct processBatch call only)
  const ARGS: bool              // the hub's watcher reads the secret in a dispute's arguments (the start's, the finalize's), as it reads SecretRevealed (#167)
  const HOP: int                // the hub's upstream deadline is this far after its onward one (E3: HOP >= REACT = 2 * LAG)
  const XREV: bool              // the payee may reveal by calling DeltaTransformer.revealSecret directly (no Depository event)
  const TSEE: bool              // the hub's watcher reads the transformer's SecretRevealed
  const BACK: bool              // the hub refuses the upstream expiry for a hash the registry shows revealed by the lock's deadline, and claims by it
  const SLK: int                // ticks after a height deadline that the contract still counts a reveal (the signed second's slack, in heights)
  const PD: int                 // ticks between an event landing and the hub (and the payee) hearing it: depth and poll
  const RSV: int                // the reserve: the upstream lock expires at a view strictly past TU + RSV
  const CHAIN: bool             // the hub's claim on U is a chain claim, counted until the lock's second, TU + SLK
  const RD: int                 // ticks the read of a finalize's calldata takes beyond hearing the finalize (a provider that fails the trace for a while)
  const LK: int                 // the tick the hub's paybook entry for the lock exists from: a reveal it hears before then reaches no entry (frame.ts named, paybook.ts revealed)
  const ADM: int                // the registry read at the lock's admission, -1 none, else how many ticks behind the Entity's view the read block is (PR 176 owed row)
  const HG: bool                // the expiry's wait is the code's height gate (the view past the deadline plus the reserve), not the lock's second
  const LATE: bool              // the Entity is told the finalize before the read of its calldata lands, and the read after (PR 171 before the watch-wait design)

  pure val W = 4                // the dispute window, ticks
  pure val LAG = 1              // a J transaction lands within this many ticks of the ask
  pure val TD = 9               // deadline of the hold on D, the downstream Account
  pure val TU = TD + HOP        // deadline of the lock on U
  pure val TDX = TD + SLK       // the second of the downstream deadline, in ticks: the contract counts a reveal or an argument up to here
  pure val TUX = TU + SLK       // the second of the upstream deadline
  pure val MAXT = TUX + PD + RSV + 2
  pure val MAXE = 2             // one dispute, one epoch move

  type Side = | Hub | Payee
  pure val SIDES = Set(Hub, Payee)
  pure def other(s: Side): Side = match s { | Hub => Payee | Payee => Hub }

  // What each side's Entity knows of D: its epoch, whether it holds a dispute record (FREEZE: it seals and accepts nothing), the hold
  // on D in its view.
  type View = { epoch: int, rec: bool, hold: bool }

  // A J transaction asked for and not yet landed.
  type Ask = { on: bool, carried: bool, shown: bool, epoch: int, at: int }
  pure val NO_ASK: Ask = { on: false, carried: false, shown: false, epoch: 0, at: 0 }

  // The chain's dispute record on D: the starter, the end of the window, whether the proof it opened with carries the hold.
  type Disp = { on: bool, starter: Side, timeout: int, carried: bool, shown: bool }
  pure val NO_DISP: Disp = { on: false, starter: Hub, timeout: 0, carried: false, shown: false }

  // The chain's events in order: kind 0 DisputeStarted, 1 SecretRevealed of the Depository (at `t`), 2 SecretRevealed of the transformer alone
  // (a direct revealSecret), 3 DisputeFinalized and epoch advance (`carried`: the finalized proof carried the hold).
  type Ev = { kind: int, by: Side, t: int, epoch: int, carried: bool, shown: bool }

  // A frame in flight: the payee's release of the hold, sealed in `epoch`; stage 0 on its way to H, 1 committed there and the ack on its way.
  type Pend = { on: bool, epoch: int, stage: int }
  pure val NO_PEND: Pend = { on: false, epoch: 0, stage: 0 }

  type St = {
    now: int,
    chEpoch: int, disp: Disp, revealedAt: int, log: List[Ev],
    seen: Side -> int, v: Side -> View,
    knows: bool,                       // the hub's paybook has the secret
    pend: Pend,
    askS: Side -> Ask, askR: Ask, askC: Ask,
    paidFrame: int, paidChain: int,    // what Y was paid on D: by a committed release frame of the epoch, by the chain at a finalize
    u: int,                            // the lock on U: 0 open, 1 claimed by H, 2 expired to P
    collected: int,
    finals: int, lateReveal: bool,
    viaReg: bool                       // the hub claimed on U by the registry (BACK)
  }

  var st: St

  pure def both(x) = Map(Hub -> x, Payee -> x)
  pure def finTime(d: Disp): int = if (d.carried and d.timeout < TDX) TDX else d.timeout
  pure def out(s: St): int = s.paidFrame + s.paidChain
  pure def quiet(w: View): bool = w.rec

  action init: bool = {
    st' = {
      now: 1, chEpoch: 1, disp: NO_DISP, revealedAt: 0, log: List(),
      seen: both(0), v: both({ epoch: 1, rec: false, hold: true }),
      knows: false, pend: NO_PEND,
      askS: both(NO_ASK), askR: NO_ASK, askC: NO_ASK,
      paidFrame: 0, paidChain: 0, u: 0, collected: 0,
      finals: 0, lateReveal: false, viaReg: false
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Time. It passes only when every Entity has heard the chain, every ask that can land has landed within LAG, the hub has asked for the
  // claim it owes, and a finalize that became possible has landed within LAG.
  // ---------------------------------------------------------------------------------------------------------

  // The tick from which the hub (or the payee) can be told an event. A finalize waits for the read of its calldata when it is told in order (the watch-wait
  // design: an entry whose read is pending stays locked through the finalize); LATE tells it at once and the read follows.
  pure def heardFrom(e: Ev): int = e.t + PD + (if (e.kind == 3 and not(LATE)) RD else 0)
  // The read of a finalize's calldata that the hub was told of and has not yet read (LATE).
  pure def lateRead(s: St): bool =
    LATE and ARGS and not(s.knows) and
    s.log.indices().exists(i => i < s.seen.get(Hub) and s.log.nth(i).kind == 3 and s.log.nth(i).shown and s.log.nth(i).t + PD + RD <= s.now)

  pure def finalizable(s: St): bool = s.disp.on and s.now >= finTime(s.disp)

  pure def claimLandable(s: St): bool = s.u == 0 and s.now <= (if (CHAIN) TUX else TU)

  // The registry shows a reveal the contract counts for the lock on U (by its second), and the hub's read at depth has it.
  pure def regShows(s: St): bool = s.revealedAt != 0 and s.revealedAt <= TUX
  pure def regClaimable(s: St): bool = BACK and s.u == 0 and regShows(s) and s.revealedAt + PD <= s.now

  pure def owed(s: St): bool = or {
    SIDES.exists(x => s.seen.get(x) < s.log.length() and heardFrom(s.log.nth(s.seen.get(x))) <= s.now),
    lateRead(s),
    regClaimable(s),
    SIDES.exists(x => s.askS.get(x).on and s.askS.get(x).at + LAG <= s.now),
    s.askR.on and s.askR.at + LAG <= s.now,
    s.askC.on and claimLandable(s) and s.askC.at + LAG <= s.now,
    s.knows and claimLandable(s) and not(s.askC.on),
    finalizable(s) and s.now >= finTime(s.disp) + LAG
  }

  action tick: bool = all {
    st.now < MAXT, not(owed(st)),
    st' = { ...st, now: st.now + 1 }
  }

  // ---------------------------------------------------------------------------------------------------------
  // An Entity hears the chain's next event. A start makes it quiet; the secret reaches the hub's paybook only with SEE; the epoch advance
  // rebases: the dispute record is gone, the hold is dissolved only with DISSOLVE and only if the finalized proof carried it.
  // ---------------------------------------------------------------------------------------------------------

  action hear(s: Side): bool = {
    val i = st.seen.get(s)
    all {
      i < st.log.length(),
      heardFrom(st.log.nth(i)) <= st.now,
      val e = st.log.nth(i)
      val w = st.v.get(s)
      val w2 =
        if (e.kind == 0) { ...w, rec: true }
        else if (e.kind == 3 and e.epoch > w.epoch)
          { epoch: e.epoch, rec: false, hold: if (DISSOLVE and e.carried) false else w.hold }
        else w
      st' = { ...st,
        seen: st.seen.set(s, i + 1),
        v: st.v.set(s, w2),
        knows: st.knows or (s == Hub and st.now >= LK and ((e.kind == 1 and SEE) or (e.kind == 2 and TSEE) or (ARGS and e.shown and not(LATE)))),
        // LATE: the finalize reaches the paybook before its secret, so the entry for the carried hold is dissolved and the inbound lock on U is given up
        // (R-HOLD-DISSOLVE, frame.ts `finalized`); a secret read afterwards finds no locked entry (`revealed` acts only on locked ones)
        u: if (LATE and s == Hub and e.kind == 3 and e.carried and DISSOLVE and not(st.knows) and st.u == 0) 2 else st.u,
        askS: if (e.kind == 3) st.askS.set(s, NO_ASK) else st.askS }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // The release of the hold by frame: the payee seals it when it is not quiet; the hub commits it when it is not quiet, in the same epoch,
  // with the hold in its view and the deadline not passed (R-CLOCK); committing it teaches the hub the secret.
  // ---------------------------------------------------------------------------------------------------------

  // LATE: the read of the finalize's calldata lands after the finalize was told. If the lock on U is still open the hub learns the secret; if the
  // finalize already dissolved its entry the secret is ignored.
  action readLate: bool = all {
    lateRead(st),
    st' = { ...st, knows: st.u == 0 }
  }

  action sendRelease: bool = {
    val w = st.v.get(Payee)
    all {
      not(st.pend.on), w.hold, not(quiet(w)), st.now <= TD,
      st' = { ...st, pend: { on: true, epoch: w.epoch, stage: 0 } }
    }
  }

  action receive: bool = {
    val w = st.v.get(Hub)
    all {
      st.pend.on, st.pend.stage == 0,
      if (w.epoch != st.pend.epoch or quiet(w) or not(w.hold) or st.now > TD)
        st' = { ...st, pend: NO_PEND }
      else
        st' = { ...st, pend: { ...st.pend, stage: 1 }, v: st.v.set(Hub, { ...w, hold: false }),
                paidFrame: st.paidFrame + 1, knows: true }
    }
  }

  action ack: bool = all {
    st.pend.on, st.pend.stage == 1,
    val w = st.v.get(Payee)
    st' = { ...st, pend: NO_PEND, v: if (w.epoch == st.pend.epoch) st.v.set(Payee, { ...w, hold: false }) else st.v }
  }

  // ---------------------------------------------------------------------------------------------------------
  // A dispute on D, started by either side from the proof it holds (carried: it still sees the hold open); the secret on the chain
  // ---------------------------------------------------------------------------------------------------------

  // `sh`: the payee starts with the secret in the start's arguments (the contract freezes the time of the start; the hold is paid at the finalize)
  action askStartWith(s: Side, sh: bool): bool = {
    val w = st.v.get(s)
    all {
      sh implies (s == Payee),
      not(w.rec), w.hold, w.epoch < MAXE, not(st.askS.get(s).on),
      st' = { ...st, v: st.v.set(s, { ...w, rec: true }),
              askS: st.askS.set(s, { on: true, carried: w.hold, shown: sh, epoch: w.epoch, at: st.now }) }
    }
  }

  action askStart(s: Side): bool = any { askStartWith(s, false), askStartWith(s, true) }

  action landStart(s: Side): bool = {
    val a = st.askS.get(s)
    all {
      a.on,
      if (st.disp.on or a.epoch != st.chEpoch)
        st' = { ...st, askS: st.askS.set(s, NO_ASK) }
      else
        st' = { ...st, askS: st.askS.set(s, NO_ASK),
                disp: { on: true, starter: s, timeout: st.now + W, carried: a.carried, shown: a.shown and st.now <= TDX },
                log: st.log.append({ kind: 0, by: s, t: st.now, epoch: st.chEpoch, carried: a.carried, shown: a.shown and st.now <= TDX }) }
    }
  }

  // The payee puts the secret on the chain, whenever it likes while it sees the hold open (it may be late, then the clause is lost).
  action askReveal: bool = all {
    st.v.get(Payee).hold, not(st.askR.on), st.revealedAt == 0,
    st' = { ...st, askR: { on: true, carried: false, shown: false, epoch: 0, at: st.now } }
  }

  // `direct`: the payee calls the transformer itself; the registry is set all the same, only the Depository's event is missing.
  action landRevealVia(direct: bool): bool = all {
    direct implies XREV, st.askR.on,
    st' = { ...st, askR: NO_ASK, revealedAt: st.now,
            log: st.log.append({ kind: if (direct) 2 else 1, by: Payee, t: st.now, epoch: st.chEpoch, carried: false, shown: false }),
            lateReveal: st.now > TDX }
  }

  action landReveal: bool = landRevealVia(false)
  action landRevealDirect: bool = landRevealVia(true)

  // The chain finalizes: a carried hold is paid to Y iff the secret was registered by TD, else refunded; the epoch advances; a frame the
  // finalize outdates is zeroed (the proof that paid does not contain it).
  action landFinal: bool = all {
    finalizable(st),
    val paid = st.disp.carried and ((st.revealedAt != 0 and st.revealedAt <= TDX) or st.disp.shown)
    st' = { ...st, disp: NO_DISP, chEpoch: st.chEpoch + 1, askS: both(NO_ASK),
            paidChain: st.paidChain + (if (paid) 1 else 0),
            paidFrame: if (st.disp.carried) 0 else st.paidFrame,
            finals: st.finals + 1,
            log: st.log.append({ kind: 3, by: st.disp.starter, t: st.now, epoch: st.chEpoch + 1, carried: st.disp.carried, shown: false }) }
  }

  // The payee finalizes with the secret in its own arguments: the clause is paid at once, without waiting for TD and without a SecretRevealed.
  // Fresh arguments are the non-starter's alone (Account.sol: a starter may not supply `otherArguments`), so the hub started; the non-starter may
  // finalize the opening state at once, before the window ends (no Pull in the body). The finalize shows the secret to whoever reads its calldata; `wrapped`: it was relayed through a contract, so the
  // watcher's read finds no finalize op in the input (`unread`) and learns nothing.
  action landFinalShown: bool = any { landFinalShownVia(false), landFinalShownVia(true) }

  action landFinalShownVia(wrapped: bool): bool = all {
    wrapped implies HIDE, st.disp.on, st.disp.carried, st.disp.starter == Hub, st.now <= TDX,
    st' = { ...st, disp: NO_DISP, chEpoch: st.chEpoch + 1, askS: both(NO_ASK),
            paidChain: st.paidChain + 1, paidFrame: 0, finals: st.finals + 1,
            log: st.log.append({ kind: 3, by: Payee, t: st.now, epoch: st.chEpoch + 1, carried: true, shown: not(wrapped) }) }
  }

  // ---------------------------------------------------------------------------------------------------------
  // The upstream Account U: the hub claims once it knows the secret; the payer lets the lock expire after TU
  // ---------------------------------------------------------------------------------------------------------

  action askClaim: bool = all {
    st.knows, claimLandable(st), not(st.askC.on),
    st' = { ...st, askC: { on: true, carried: false, shown: false, epoch: 0, at: st.now } }
  }

  action landClaim: bool = all {
    st.askC.on,
    if (claimLandable(st)) st' = { ...st, askC: NO_ASK, u: 1, collected: 1 }
    else st' = { ...st, askC: NO_ASK }
  }

  // The upstream lock expires to the payer once the view is strictly past TU + RSV. A hub that can still claim does not co-sign it (CHAIN),
  // and with BACK it does not co-sign it before its read at depth covers the lock's second, nor while the registry shows a reveal by it.
  // `regSeen`: the registry's reveal the hub's read at its view block shows now: it landed PD ticks ago or more, and the contract counts it for the lock.
  pure def regSeen(s: St): bool = regShows(s) and s.revealedAt + PD <= s.now
  pure def expirable(s: St): bool = all {
    s.u == 0, s.now > TU + RSV,
    CHAIN implies not(s.knows and s.now <= TUX),
    BACK implies ((if (HG) s.now > TU + RSV + PD else s.now >= TUX + PD) and not(regSeen(s)))
  }
  action expireU: bool = all {
    expirable(st),
    st' = { ...st, u: 2 }
  }

  // BACK: the registry pays the clause on U to the hub (a dispute on U finalizes by it), at once as far as the model goes.
  action claimByRegistry: bool = all {
    regClaimable(st),
    st' = { ...st, u: 1, collected: 1, viaReg: true }
  }

  action step: bool = any {
    tick, receive, ack, sendRelease, askReveal, landReveal, landRevealDirect, landFinal, landFinalShown, askClaim, landClaim, expireU,
    claimByRegistry, readLate,
    { nondet s = SIDES.oneOf() any { hear(s), askStart(s), landStart(s) } }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Properties and witnesses
  // ---------------------------------------------------------------------------------------------------------

  val paid_once: bool = out(st) <= 1
  val route_safe: bool = (st.u != 0) implies (out(st) <= st.collected)
  val safe: bool = paid_once and route_safe

  val w_no_dispute: bool = not(st.disp.on)
  val w_no_reveal: bool = st.revealedAt == 0
  val w_no_chain_paid: bool = st.paidChain == 0
  val w_no_frame_paid: bool = st.paidFrame == 0
  val w_no_claim: bool = st.u != 1
  val w_no_epoch_move: bool = st.finals == 0
  val w_no_direct_reveal: bool = st.log.select(e => e.kind == 2).length() == 0
  val w_no_registry_claim: bool = not(st.viaReg)
  // (expiry of the lock on U is a schedule: every scenario test that ends in closeU reaches it; the random search seldom does)
}
