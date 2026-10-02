// The dispute lifecycle of one Account, as a whole: both Entities, the chain between them, and the frames in flight.
//
// WHY THIS FILE EXISTS. account.qnt, chain.qnt and entity.qnt each hold a slice (the frame rounds, the contract's dispute game, the
// Entity's frame). Every audit of the dispute code (#159, #160 and the two before) found a bug in how the slices meet: a counter that
// lapses for good, a starter that never finalizes, a payment zeroed in the gap between the chain's finalize and the Entity hearing
// of it. None of those is a bug of one slice. This file puts the three together at the level where they meet and nothing finer:
// a proof is its NONCE (a frame's number; the ledger it signs is "n - base payments"), a dispute is the chain's record of one proof
// and at most one counter, an Entity is its chain facts (pure/entity/chain.ts `ChainFacts` as of #160: `starting`, `against`, `answer`)
// plus the frame it has in flight. Money is not modelled: a payment is a frame, and "zeroed" means a frame both sides may count
// as committed is not the state the chain pays.
//
// SOURCES (read on development 10ced64d3 and #160 d57ee8112, 10-02):
//   Account.sol  _disputeStart 1834-1980 (skips: nonce not above stored, dispute active, epoch moved), _registerCounterDispute
//                1507-1623 (non-starter only; newer nonce; window open; one counter, the newest), prepareDisputeFinalization 721-910
//                (counter registered: from T, either side, the counter's proof; no counter: the non-starter at once, the starter from
//                T; the epoch advances), _settleDiffs 1664 (a settlement reverts while a dispute is open)
//   entity/chain.ts  disputeAsked, windowOpened, startLapsed, windowOver, disputeOver, epochAdvanced
//   entity/frame.ts  disputed (dispute_pending), counterOf, answering, finalFor, proposing (only `frozen` stops it)
//   host/shell/drive/drive.ts  lapsedInputs: a start or counter the builder's simulation says would revert is dropped and the
//                Entity is told (`j_start_lapsed`, `j_counter_lapsed`); a start the CHAIN skips is told to nobody
//
// THREE SWITCHES, the fixes the coordinator decided on 10-02 and the one this model says is missing:
//   FREEZE  R-DISPUTE-FREEZE: an Entity with a dispute record (its own start or one against it) seals no frame and refuses the
//           peer's with `frozen`
//   LIVE    a counter lapses only on a permanent revert (E2, E4, E9), never on a transient one, so it is retried while the window
//           is open; and the starter finalizes with a registered counter after the window
//   ACCEPT  the non-starter that holds nothing newer than the dispute's proof finalizes with it (the contract lets it at once)
//   NOTICE  (not decided; R-DISPUTE-VOIDED-NOTICE, owed) an Entity that rebases with committed frames beyond the settled proof is told
//
// Time is in ticks (1 tick = the response-window floor); a J transaction lands within LAG ticks of being asked for.
// Each Entity hears the chain's events in the chain's order, one at a time, and an Entity that hears nothing keeps its facts.

module dispute {
  const FREEZE: bool
  const LIVE: bool
  const ACCEPT: bool
  const NOTICE: bool
  // The payment path (frames that carry a payment, their fate in an epoch move). 0 not modelled. 1 the code at #162 8f82733df: a node
  // that holds a peer's signed frame it refused (it was in a dispute) can finalize with it (SIGFIN), the proposer of a refused or
  // uncommitted frame seals it again in the new epoch (RESEND). 2 as 1, and a frame the chain finalized by is dropped, never sealed
  // again (DROPPAID: the coordinator's decision after the fourth audit).
  const PAY: int
  // PAY=3: as 2, and the node drops the payment of every frame it signed in the epoch, a frame rolled back on a refusal too (Review A on 61e47255).

  pure val NEVER = 999          // a nonce no proof reaches: a frame no peer held
  pure val DROPPAID = PAY >= 2
  pure val DROPALL = PAY >= 3
  pure val W = 4                // the dispute window: the sum of the two response windows (each at the floor, 2 ticks: chain.qnt MIN_WINDOW), in ticks
  pure val LAG = 1              // a J transaction lands within this many ticks of the ask
  pure val MAXT = 10            // the clock stops here
  pure val MAXF = 3             // frames per epoch
  pure val MAXE = 3             // the chain stops advancing epochs here
  pure val MAXCRASH = 2         // crashes in a run (both sides together)
  pure val MAXDROP = 1          // transient reverts the Host's simulation reports in a run, for starts and for counters each

  type Side = | Left | Right
  pure def other(s: Side): Side = match s { | Left => Right | Right => Left }
  pure val SIDES = Set(Left, Right)

  // What an Entity knows of the chain for this Account (entity/chain.ts ChainFacts, #160).
  //   s*  my own start:      sNonce the proof it opened with, sWin the chain gave it a window, sOver the window is over,
  //                          sCtd the nonce of the counter I heard registered (0: none)
  //   a*  a dispute against me: aNonce the proof it opened with, aOver its window is over
  //   c*  my answer to it:   cNonce the proof I countered with, cReg the chain registered it, cDead it lapsed (told by the Host)
  type Facts = {
    epoch: int, base: int,
    sOn: bool, sNonce: int, sWin: bool, sOver: bool, sCtd: int,
    aOn: bool, aNonce: int, aOver: bool,
    cOn: bool, cNonce: int, cReg: bool, cDead: bool
  }

  // A J transaction asked for and not yet landed: what the Entity named (`n` the proof, `init` the dispute's opening nonce).
  type Ask = { on: bool, n: int, init: int, epoch: int, at: int }
  pure val NO_ASK: Ask = { on: false, n: 0, init: 0, epoch: 0, at: 0 }

  // The chain's dispute record: the starter, the proof it opened with, the end of the window, the registered counter (0 none),
  // and whether the watcher has told the window is over.
  type Disp = { on: bool, starter: Side, n: int, timeout: int, ctr: int, over: bool }
  pure val NO_DISP: Disp = { on: false, starter: Left, n: 0, timeout: 0, ctr: 0, over: false }

  // The chain's events, in the chain's order. kind 0 DisputeStarted, 1 CounterDisputeRegistered, 2 window over (from the block
  // clock), 3 DisputeFinalized with the epoch advance (`settled` the proof that paid, `stored` what the chain stores now).
  type Ev = { kind: int, by: Side, n: int, epoch: int, timeout: int, settled: int, stored: int }

  // A frame in flight: sealed by `p` at nonce `n` in `p`'s epoch; stage 0 on its way to the other side, 1 committed there and
  // its ack on the way back.
  // Stage 2 (PAY > 0): the other side refused it while in a dispute but holds the signature on it, so a proof of it can reach the chain.
  // `pid` names the payment the frame carries; a payment sealed again keeps its pid.
  type Pend = { on: bool, p: Side, n: int, epoch: int, stage: int, pid: int }
  pure val NO_PEND: Pend = { on: false, p: Left, n: 0, epoch: 0, stage: 0, pid: 0 }

  // What the invariants watch. `zeroed[s]`: s rebased with a frame it had committed beyond the proof that paid; `told[s]`: and was told.
  // `wasDown[s]`: s was down at some time since the dispute opened. `lostNewest`: a dispute paid a proof older than the newest
  // co-signed one although a live party could have enforced the newest.
  type Ghost = {
    zeroed: Side -> bool, told: Side -> bool, wasDown: Side -> bool, lostNewest: bool,
    crashes: int, finals: int, counters: int, starts: int, skipsStart: int, lapsedCounters: int, lapsedStarts: int, settledLast: int, lostBy: int,
    // payments: `nextPid` the last pid given, `owes[s]` the pid s seals again next (0 none), `chain` the pids a finalize paid by its body,
    // `double` a pid committed after the chain paid it, `sigs` finalizes with a newer signed proof and no counter
    nextPid: int, owes: Side -> int, chain: Set[int], double: bool, sigs: int,
    // `kept[s]`: the nonce of the newest frame s refused in a dispute and holds the payer's signature on. s's Entity does not use it as a proof
    // (the proofs map is written only by a committed round, frame.ts 191-192): only a finalize built outside the Entity can.
    kept: Side -> int, keptPid: Side -> int, owesN: Side -> int
  }

  type St = {
    now: int,
    chEpoch: int, chStored: int, disp: Disp, log: List[Ev],
    seen: Side -> int, up: Side -> bool, fresh: Side -> bool, frz: Side -> bool, f: Side -> Facts,
    comm: Side -> int,       // the nonce of the newest frame each side committed in its own epoch (its ledger)
    hold: Side -> int,       // the nonce of the newest proof each side holds: a frame it committed, so the peer's signature on it
    pend: Pend,
    askS: Side -> Ask, askC: Side -> Ask, askF: Side -> Ask,
    g: Ghost
  }

  var st: St

  // ---------------------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------------------

  pure def imax(a: int, b: int): int = if (a > b) a else b
  pure def both(v) = Map(Left -> v, Right -> v)
  pure def mapAt(m, s, v) = m.set(s, v)

  pure def freshFacts(epoch: int, base: int): Facts = {
    epoch: epoch, base: base,
    sOn: false, sNonce: 0, sWin: false, sOver: false, sCtd: 0,
    aOn: false, aNonce: 0, aOver: false,
    cOn: false, cNonce: 0, cReg: false, cDead: false
  }

  // A dispute record of either kind: the node is in a dispute and, with FREEZE, seals and accepts nothing.
  pure def quiet(fc: Facts): bool = FREEZE and (fc.sOn or fc.aOn)

  // The Entity's phase for this Account, in the coordinator's vocabulary.
  //   0 none, 1 own start pending (asked, no window yet), 2 own start registered, 3 peer start seen (nothing answered),
  //   4 counter pending, 5 counter registered, 6 counter lapsed, 7 window over (a dispute record whose window ended)
  pure def phase(fc: Facts): int =
    if (fc.aOn and fc.aOver) 7
    else if (fc.sOn and fc.sOver) 7
    else if (fc.aOn and fc.cOn and fc.cDead) 6
    else if (fc.aOn and fc.cOn and fc.cReg) 5
    else if (fc.aOn and fc.cOn) 4
    else if (fc.aOn) 3
    else if (fc.sOn and fc.sWin) 2
    else if (fc.sOn) 1
    else 0

  // ---------------------------------------------------------------------------------------------------------
  // The Entity hears the chain (entity/frame.ts chainFact)
  // ---------------------------------------------------------------------------------------------------------

  pure def hearing(fc: Facts, s: Side, e: Ev): Facts =
    if (e.kind == 0) {
      // a dispute of another epoch than the one the Entity knows is not about its proofs (disputeOpened, windowOpened)
      if (e.epoch != fc.epoch) fc
      else if (e.by == s) { if (fc.sOn and fc.sNonce == e.n and not(fc.sWin)) { ...fc, sWin: true } else fc }
      else { ...fc, aOn: true, aNonce: e.n, aOver: false, cOn: false, cNonce: 0, cReg: false, cDead: false }
    } else if (e.kind == 1) {
      val a = if (fc.sOn and fc.sWin) { ...fc, sCtd: e.n } else fc
      if (a.aOn and a.cOn and a.cNonce == e.n) { ...a, cReg: true } else a
    } else if (e.kind == 2) {
      { ...fc, sOver: fc.sOn and fc.sWin, aOver: fc.aOn }
    } else {
      // the epoch moved on: every dispute record is over, the proofs of the old epoch are void (epochAdvanced, disputeOver)
      if (e.epoch <= fc.epoch) fc else freshFacts(e.epoch, e.stored + 1)
    }

  // ---------------------------------------------------------------------------------------------------------
  // What the Entity asks for (entity/frame.ts counterOf, answering, finalFor), as a function of its facts and the proof it holds
  // ---------------------------------------------------------------------------------------------------------

  // The finalize the Entity asks for, or NO_ASK. today: the starter with its opening proof once its window is over and no counter
  // was heard; the answerer with its registered counter once the window it answers is over. LIVE adds the starter with the heard
  // counter. ACCEPT adds the non-starter that has nothing newer than the dispute's proof.
  pure def wantFinal(fc: Facts, hold: int, now: int): Ask =
    if (fc.aOn and fc.aOver and fc.cOn and fc.cReg) { on: true, n: fc.cNonce, init: fc.aNonce, epoch: fc.epoch, at: now }
    else if (fc.sOn and fc.sWin and fc.sOver and fc.sCtd == 0) { on: true, n: fc.sNonce, init: fc.sNonce, epoch: fc.epoch, at: now }
    else if (LIVE and fc.sOn and fc.sWin and fc.sOver and fc.sCtd != 0) { on: true, n: fc.sCtd, init: fc.sNonce, epoch: fc.epoch, at: now }
    else if (ACCEPT and fc.aOn and not(fc.cOn) and hold <= fc.aNonce) { on: true, n: fc.aNonce, init: fc.aNonce, epoch: fc.epoch, at: now }
    else NO_ASK

  // The counter the Entity asks for: the one it asked first, restated until registered or lapsed; or, with none yet, the newest
  // proof it holds if the chain would rank it above the dispute's (a higher nonce).
  pure def counterNow(fc: Facts, hold: int): bool = fc.aOn and not(fc.cOn) and hold > fc.aNonce and hold > fc.base

  // ---------------------------------------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------------------------------------

  action init: bool = {
    st' = {
      now: 1,
      chEpoch: 1, chStored: 0, disp: NO_DISP, log: List(),
      seen: both(0), up: both(true), fresh: both(false), frz: both(false), f: both(freshFacts(1, 1)),
      comm: both(1), hold: both(1), pend: NO_PEND,
      askS: both(NO_ASK), askC: both(NO_ASK), askF: both(NO_ASK),
      g: {
        zeroed: both(false), told: both(false), wasDown: both(false), lostNewest: false,
        crashes: 0, finals: 0, counters: 0, starts: 0, skipsStart: 0, lapsedCounters: 0, lapsedStarts: 0, settledLast: 0, lostBy: 0,
        nextPid: 0, owes: both(0), chain: Set(), double: false, sigs: 0, kept: both(0), keptPid: both(0), owesN: both(0)
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Time. It passes only when nothing the honest side owes is overdue: every up Entity has heard all the chain said and run its
  // duties on it, and every J transaction that can land has landed within LAG. The window's end is told before the next tick.
  // ---------------------------------------------------------------------------------------------------------

  pure def landableFinal(s: St, side: Side): bool = {
    val a = s.askF.get(side)
    and {
      a.on, s.disp.on, a.init == s.disp.n,
      if (s.disp.ctr != 0) and { s.now >= s.disp.timeout, a.n == s.disp.ctr }
      else and { a.n == s.disp.n, (side == s.disp.starter) implies (s.now >= s.disp.timeout) }
    }
  }

  pure def owed(s: St): bool = or {
    s.disp.on and s.now >= s.disp.timeout and not(s.disp.over),
    SIDES.exists(x => s.up.get(x) and (s.seen.get(x) < s.log.length() or s.fresh.get(x))),
    SIDES.exists(x => s.askS.get(x).on and s.askS.get(x).at + LAG <= s.now),
    SIDES.exists(x => s.askC.get(x).on and s.askC.get(x).at + LAG <= s.now),
    SIDES.exists(x => landableFinal(s, x) and s.askF.get(x).at + LAG <= s.now)
  }

  action tick: bool = all {
    st.now < MAXT,
    not(owed(st)),
    st' = { ...st, now: st.now + 1 }
  }

  // The watcher tells the window is over, once the clock is past it.
  action windowOver: bool = all {
    st.disp.on, st.now >= st.disp.timeout, not(st.disp.over),
    st' = { ...st, disp: { ...st.disp, over: true },
            log: st.log.append({ kind: 2, by: Left, n: 0, epoch: st.chEpoch, timeout: 0, settled: 0, stored: 0 }) }
  }

  // ---------------------------------------------------------------------------------------------------------
  // An Entity hears the next event; goes down and comes back
  // ---------------------------------------------------------------------------------------------------------

  action hear(s: Side): bool = {
    val i = st.seen.get(s)
    all {
      st.up.get(s), i < st.log.length(),
      val e = st.log.nth(i)
      val rebase = e.kind == 3 and e.epoch > st.f.get(s).epoch
      val beyond = rebase and st.comm.get(s) > e.settled
      st' = { ...st,
        seen: mapAt(st.seen, s, i + 1),
        fresh: mapAt(st.fresh, s, true),
        frz: if (rebase) mapAt(st.frz, s, false) else st.frz,
        f: mapAt(st.f, s, hearing(st.f.get(s), s, e)),
        comm: if (rebase) mapAt(st.comm, s, e.stored + 1) else st.comm,
        hold: if (rebase) mapAt(st.hold, s, e.stored + 1) else st.hold,
        // an ask of the old epoch is void once the Entity knows it
        askS: if (rebase) mapAt(st.askS, s, NO_ASK) else st.askS,
        askC: if (rebase) mapAt(st.askC, s, NO_ASK) else st.askC,
        askF: if (rebase) mapAt(st.askF, s, NO_ASK) else st.askF,
        // PAY > 0: the proposer of a frame the peer holds learns the epoch moved. A frame the peer committed is acked again and rebased
        // (the Entity keeps it pending, its after-state is rebased: nothing is paid twice). A frame the peer only holds the signature of
        // is sealed again in the new epoch, unless the chain paid by a proof that held it and DROPPAID knows it.
        pend: if (PAY > 0 and rebase and st.pend.on and st.pend.p == s and st.pend.epoch == st.f.get(s).epoch and st.pend.stage >= 1) NO_PEND else st.pend,
        g: { ...st.g,
          owes: if (PAY > 0 and rebase and st.pend.on and st.pend.p == s and st.pend.epoch == st.f.get(s).epoch and st.pend.stage == 2
                    and not(DROPPAID and st.pend.n <= e.settled))
                  mapAt(st.g.owes, s, st.pend.pid)
                else if (DROPALL and rebase and st.g.owes.get(s) != 0 and st.g.owesN.get(s) <= e.settled)
                  mapAt(st.g.owes, s, 0)
                else st.g.owes,
          owesN: if (PAY > 0 and rebase and st.pend.on and st.pend.p == s and st.pend.epoch == st.f.get(s).epoch and st.pend.stage == 2
                     and not(DROPPAID and st.pend.n <= e.settled)) mapAt(st.g.owesN, s, NEVER) else st.g.owesN,
          kept: if (rebase) mapAt(st.g.kept, s, 0) else st.g.kept,
          keptPid: if (rebase) mapAt(st.g.keptPid, s, 0) else st.g.keptPid,
          zeroed: if (beyond) mapAt(st.g.zeroed, s, true) else st.g.zeroed,
          told: if (beyond and NOTICE) mapAt(st.g.told, s, true) else st.g.told }
      }
    }
  }

  // Each side goes down at most MAXCRASH times in a run: the search is about what the code does around a crash, not about how many.
  action crash(s: Side): bool = all {
    st.up.get(s), st.g.crashes < MAXCRASH,
    st' = { ...st, up: mapAt(st.up, s, false),
            g: { ...st.g, crashes: st.g.crashes + 1,
                 wasDown: if (st.disp.on) mapAt(st.g.wasDown, s, true) else st.g.wasDown } }
  }

  action restart(s: Side): bool = all {
    not(st.up.get(s)),
    st' = { ...st, up: mapAt(st.up, s, true), fresh: mapAt(st.fresh, s, true) }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Frames (account.qnt at the level where the dispute meets it). A frame commits on the receiver, then on the sender when its ack
  // arrives. A frame of another epoch than the receiver's is refused and taken back; with FREEZE a node in a dispute refuses every
  // frame (`frozen`) and seals none.
  // ---------------------------------------------------------------------------------------------------------

  action seal(p: Side): bool = {
    val fc = st.f.get(p)
    all {
      st.up.get(p), not(st.pend.on), not(quiet(fc)), not(st.frz.get(p)),
      st.comm.get(p) < fc.base + MAXF,
      val again = st.g.owes.get(p)
      val pid = if (again != 0) again else st.g.nextPid + 1
      st' = { ...st, pend: { on: true, p: p, n: st.comm.get(p) + 1, epoch: fc.epoch, stage: 0, pid: pid },
              g: { ...st.g, nextPid: if (again != 0) st.g.nextPid else pid, owes: mapAt(st.g.owes, p, 0), owesN: mapAt(st.g.owesN, p, 0) } }
    }
  }

  action receive: bool = {
    val a = other(st.pend.p)
    val fa = st.f.get(a)
    val p = st.pend.p
    all {
      st.pend.on, st.pend.stage == 0, st.up.get(a),
      if (fa.epoch != st.pend.epoch)
        // another epoch's: taken back, and with RESEND the proposer seals its payment again
        st' = { ...st, pend: NO_PEND,
                g: { ...st.g, owes: if (PAY > 0) mapAt(st.g.owes, p, st.pend.pid) else st.g.owes,
                     owesN: if (PAY > 0) mapAt(st.g.owesN, p, NEVER) else st.g.owesN } }
      else if (quiet(fa) or st.frz.get(a) or st.pend.n != st.comm.get(a) + 1)
        if (PAY > 0 and (quiet(fa) or st.frz.get(a)) and st.pend.n == st.comm.get(a) + 1)
          // refused, but the signature on it is held (not as the Entity's proof)
          st' = { ...st, pend: { ...st.pend, stage: 2 }, g: { ...st.g, kept: mapAt(st.g.kept, a, st.pend.n), keptPid: mapAt(st.g.keptPid, a, st.pend.pid) } }
        else
          st' = { ...st, pend: NO_PEND }
      else
        st' = { ...st, pend: { ...st.pend, stage: 1 },
                comm: mapAt(st.comm, a, st.pend.n), hold: mapAt(st.hold, a, st.pend.n), fresh: mapAt(st.fresh, a, true),
                g: { ...st.g, double: st.g.double or st.g.chain.contains(st.pend.pid) } }
    }
  }

  // PAY: the refusal comes back to the payer as retryable before it hears of the dispute: the frame is rolled back, its payment goes back to
  // the mempool to be sealed again, and the peer still holds the payer's signature on it.
  action rollback: bool = all {
    PAY > 0, st.pend.on, st.pend.stage == 2, st.up.get(st.pend.p),
    st' = { ...st, pend: NO_PEND,
            g: { ...st.g, owes: mapAt(st.g.owes, st.pend.p, st.pend.pid), owesN: mapAt(st.g.owesN, st.pend.p, st.pend.n) } }
  }

  action ack: bool = {
    val p = st.pend.p
    all {
      st.pend.on, st.pend.stage == 1, st.up.get(p),
      if (st.f.get(p).epoch == st.pend.epoch)
        st' = { ...st, pend: NO_PEND, comm: mapAt(st.comm, p, st.pend.n), hold: mapAt(st.hold, p, st.pend.n),
                fresh: mapAt(st.fresh, p, true) }
      else
        st' = { ...st, pend: NO_PEND }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // The Entity's duties after an input: counter, finalize (entity/frame.ts dutiful), and the operator's dispute command
  // ---------------------------------------------------------------------------------------------------------

  action duty(s: Side): bool = {
    val fc = st.f.get(s)
    val h = st.hold.get(s)
    all {
      st.up.get(s), st.fresh.get(s),
      val first = counterNow(fc, h)
      val fc2 = if (first) { ...fc, cOn: true, cNonce: h } else fc
      val restate = fc2.aOn and fc2.cOn and not(fc2.cReg) and not(fc2.cDead)
      val counter: Ask = if (restate) { on: true, n: fc2.cNonce, init: fc2.aNonce, epoch: fc2.epoch,
                                         at: if (st.askC.get(s).on) st.askC.get(s).at else st.now }
                         else NO_ASK
      val fin = wantFinal(fc2, h, st.now)
      st' = { ...st, fresh: mapAt(st.fresh, s, false), f: mapAt(st.f, s, fc2), askC: mapAt(st.askC, s, counter),
              askF: mapAt(st.askF, s, if (fin.on and st.askF.get(s).on and st.askF.get(s).n == fin.n and st.askF.get(s).init == fin.init) st.askF.get(s) else fin) }
    }
  }

  // The operator asks the node to dispute: from the newest proof it holds, and only if it holds a signed one of its epoch and no
  // dispute record is open (frame.ts `disputed`: dispute_pending, no_proof).
  action opStart(s: Side): bool = {
    val fc = st.f.get(s)
    all {
      st.up.get(s), not(fc.sOn), not(fc.aOn), fc.epoch < MAXE, st.hold.get(s) > fc.base, not(st.askS.get(s).on),
      st' = { ...st,
        f: mapAt(st.f, s, { ...fc, sOn: true, sNonce: st.hold.get(s), sWin: false, sOver: false, sCtd: 0 }),
        askS: mapAt(st.askS, s, { on: true, n: st.hold.get(s), init: 0, epoch: fc.epoch, at: st.now }) }
    }
  }

  // The Host's simulation says a start would revert and drops it: the Entity forgets the record and may ask again.
  action dropStart(s: Side): bool = all {
    st.g.lapsedStarts < MAXDROP, st.askS.get(s).on, st.f.get(s).sOn, not(st.f.get(s).sWin),
    st' = { ...st, askS: mapAt(st.askS, s, NO_ASK),
            f: mapAt(st.f, s, { ...st.f.get(s), sOn: false }),
            g: { ...st.g, lapsedStarts: st.g.lapsedStarts + 1 } }
  }

  // The Host's simulation says a counter would revert, for a reason that may pass (a lagging node, a stale batch nonce): the
  // counter is dropped. Today the Entity is told it lapsed and never asks again (`counterLapsed`); with LIVE it is not told, and asks
  // again at its next frame while the window is open.
  action dropCounter(s: Side): bool = all {
    st.g.lapsedCounters < MAXDROP, st.askC.get(s).on, st.f.get(s).cOn, not(st.f.get(s).cReg), not(st.f.get(s).cDead),
    st' = { ...st, askC: mapAt(st.askC, s, NO_ASK),
            f: if (LIVE) st.f else mapAt(st.f, s, { ...st.f.get(s), cDead: true }),
            fresh: if (LIVE) mapAt(st.fresh, s, true) else st.fresh,
            g: { ...st.g, lapsedCounters: st.g.lapsedCounters + 1 } }
  }

  // ---------------------------------------------------------------------------------------------------------
  // The chain lands what was asked for (Account.sol). A start or counter that is stale is skipped (J2), told to nobody.
  // ---------------------------------------------------------------------------------------------------------

  action landStart(s: Side): bool = {
    val a = st.askS.get(s)
    all {
      a.on,
      if (st.disp.on or a.n <= st.chStored or a.epoch != st.chEpoch)
        st' = { ...st, askS: mapAt(st.askS, s, NO_ASK), g: { ...st.g, skipsStart: st.g.skipsStart + 1 } }
      else
        st' = { ...st,
          askS: mapAt(st.askS, s, NO_ASK),
          disp: { on: true, starter: s, n: a.n, timeout: st.now + W, ctr: 0, over: false },
          chStored: a.n,
          log: st.log.append({ kind: 0, by: s, n: a.n, epoch: st.chEpoch, timeout: st.now + W, settled: 0, stored: 0 }),
          g: { ...st.g, starts: st.g.starts + 1, wasDown: Map(Left -> not(st.up.get(Left)), Right -> not(st.up.get(Right))) } }
    }
  }

  action landCounter(s: Side): bool = {
    val a = st.askC.get(s)
    all {
      a.on,
      if (not(st.disp.on) or st.now >= st.disp.timeout or a.init != st.disp.n or s == st.disp.starter or a.n <= st.disp.n or a.n <= st.disp.ctr)
        st' = { ...st, askC: mapAt(st.askC, s, NO_ASK) }
      else
        st' = { ...st,
          askC: mapAt(st.askC, s, NO_ASK),
          disp: { ...st.disp, ctr: a.n },
          log: st.log.append({ kind: 1, by: s, n: a.n, epoch: st.chEpoch, timeout: 0, settled: 0, stored: 0 }),
          g: { ...st.g, counters: st.g.counters + 1 } }
    }
  }

  // The newest co-signed proof of the epoch, and whether a live party could have put it on the chain: a non-starter that holds it
  // could counter it; the starter holding it can enforce it only if it opened with it.
  pure def newestHeld(s: St): int =
    SIDES.fold(0, (m, x) => if (s.f.get(x).epoch == s.chEpoch) imax(m, s.hold.get(x)) else m)

  pure def enforceable(s: St, n: int): bool =
    SIDES.exists(x => and {
      s.f.get(x).epoch == s.chEpoch, s.hold.get(x) == n, not(s.g.wasDown.get(x)),
      x == s.disp.starter implies s.disp.n == n
    })

  // The payment a frame in flight carries is paid by the chain when a finalize settles on a proof that holds the frame: the other side
  // committed it or holds its signature (stage 1, 2), and the proof's nonce is at least the frame's.
  pure def paidBy(s: St, settled: int): Set[int] = {
    val inFlight = if (s.pend.on and s.pend.stage >= 1 and s.pend.epoch == s.chEpoch and s.pend.n <= settled) Set(s.pend.pid) else Set()
    // a frame the other side refused is held signed by it, and the proof of it can be the one the chain pays by, rolled back at the payer or not
    SIDES.fold(inFlight, (acc, x) =>
      if (s.g.kept.get(x) != 0 and s.f.get(x).epoch == s.chEpoch and s.g.kept.get(x) <= settled) acc.union(Set(s.g.keptPid.get(x))) else acc)
  }

  action landFinal(s: Side): bool = {
    val a = st.askF.get(s)
    all {
      landableFinal(st, s),
      val settled = a.n
      val newest = newestHeld(st)
      val stored = if (st.disp.ctr != 0) st.disp.ctr else st.disp.n + 1
      st' = { ...st,
        askS: both(NO_ASK), askC: both(NO_ASK), askF: both(NO_ASK),
        disp: NO_DISP, chEpoch: st.chEpoch + 1, chStored: stored,
        log: st.log.append({ kind: 3, by: s, n: 0, epoch: st.chEpoch + 1, timeout: 0, settled: settled, stored: stored }),
        g: { ...st.g, finals: st.g.finals + 1, settledLast: settled, chain: st.g.chain.union(paidBy(st, settled)),
             lostNewest: st.g.lostNewest or (settled < newest and enforceable(st, newest)),
             lostBy: if (settled < newest) newest - settled else st.g.lostBy } }
    }
  }

  // PAY > 0: the non-starter finalizes at once, with no counter, with a proof newer than the opening one that carries the starter's
  // signature (Depository.sol 965-970: a signature adopts finalNonce, which the chain stores). It holds the signature on a frame it
  // committed or refused.
  action landSigFinal(s: Side): bool = all {
    PAY > 0, st.disp.on, s != st.disp.starter, st.disp.ctr == 0, st.f.get(s).epoch == st.chEpoch, imax(st.hold.get(s), st.g.kept.get(s)) > st.disp.n,
    not(st.g.wasDown.get(s)),
    val settled = imax(st.hold.get(s), st.g.kept.get(s))
    val newest = newestHeld(st)
    st' = { ...st,
      askS: both(NO_ASK), askC: both(NO_ASK), askF: both(NO_ASK),
      disp: NO_DISP, chEpoch: st.chEpoch + 1, chStored: settled,
      log: st.log.append({ kind: 3, by: s, n: 0, epoch: st.chEpoch + 1, timeout: 0, settled: settled, stored: settled }),
      g: { ...st.g, finals: st.g.finals + 1, settledLast: settled, sigs: st.g.sigs + 1, chain: st.g.chain.union(paidBy(st, settled)),
           lostNewest: st.g.lostNewest or (settled < newest and enforceable(st, newest)),
           lostBy: if (settled < newest) newest - settled else st.g.lostBy } }
  }

  // A co-signed settlement or C2R lands (Account.sol 1385, 1743: it sets the nonce and advances the epoch, and reverts while a dispute is open):
  // the epoch moves with no dispute. The two Entities co-signed it, so each has been frozen since (R-COSIGN-FREEZE) and seals and accepts
  // nothing until it hears the epoch move. An ask of the old epoch that is still on its way is skipped when it lands.
  action settle: bool = all {
    not(st.disp.on), not(st.pend.on), st.chEpoch < MAXE, st.comm.get(Left) == st.comm.get(Right),
    val stored = imax(st.chStored, newestHeld(st)) + 1
    st' = { ...st, chEpoch: st.chEpoch + 1, chStored: stored, frz: both(true),
            log: st.log.append({ kind: 3, by: Left, n: 0, epoch: st.chEpoch + 1, timeout: 0, settled: stored, stored: stored }) }
  }

  action step: bool = any {
    tick,
    settle,
    rollback,
    windowOver,
    receive,
    ack,
    { nondet s = SIDES.oneOf()
      any {
      hear(s), crash(s), restart(s), seal(s), duty(s), opStart(s), dropStart(s), dropCounter(s),
      landStart(s), landCounter(s), landFinal(s), landSigFinal(s)
    } }
  }

  // ---------------------------------------------------------------------------------------------------------
  // The three properties the coordinator asked for, and the model's own sanity
  // ---------------------------------------------------------------------------------------------------------

  // 1. The newest co-signed state wins if a live party could enforce it.
  val newest_wins: bool = not(st.g.lostNewest)

  // 2. No Account stays locked forever if either side is live. A side alone (its peer down for good) that has heard everything, run
  // its duties and sees the dispute's window over must have a finalize asked or landed.
  pure def soloOk(s: St, x: Side): bool =
    not(and {
      s.disp.on, s.disp.over, s.up.get(x), s.seen.get(x) == s.log.length(), not(s.fresh.get(x)),
      s.f.get(x).epoch == s.chEpoch, s.f.get(x).sOn or s.f.get(x).aOn,
      not(s.askF.get(x).on)
    })

  val no_lock_left: bool = soloOk(st, Left)
  val no_lock_right: bool = soloOk(st, Right)
  val no_lock: bool = no_lock_left and no_lock_right

  // 3. No committed payment is zeroed without a notice: a side that rebased with a committed frame beyond the proof that paid was told.
  // 4. (PAY) Nothing the finalized body already paid is paid again in the new epoch: no payment is committed after a finalize paid it.
  val pay_once: bool = not(st.g.double)

  val no_silent_zeroing: bool = SIDES.forall(x => st.g.zeroed.get(x) implies st.g.told.get(x))

  // The model's own consistency.
  val sane: bool = and {
    st.chStored >= 0,
    st.disp.on implies st.disp.ctr == 0 or st.disp.ctr > st.disp.n,
    st.chEpoch <= MAXE
  }

  val safe: bool = and { newest_wins, no_lock, no_silent_zeroing, sane }

  // Witnesses: each state of the lifecycle is reachable (violated by a trace that reaches it).
  val w_pay_sigfin: bool = st.g.sigs == 0
  val w_pay_held: bool = st.pend.stage != 2
  val w_pay_chain: bool = st.g.chain.size() == 0
  val w_pay_rolled: bool = SIDES.forall(x => st.g.owes.get(x) == 0 or st.g.owesN.get(x) == 0 or st.g.owesN.get(x) == NEVER)
  val w_pay_owes: bool = SIDES.forall(x => st.g.owes.get(x) == 0)
  val w_no_own_start_pending: bool = SIDES.forall(x => phase(st.f.get(x)) != 1)
  val w_no_own_start_registered: bool = SIDES.forall(x => phase(st.f.get(x)) != 2)
  val w_no_peer_start_seen: bool = SIDES.forall(x => phase(st.f.get(x)) != 3)
  val w_no_counter_pending: bool = SIDES.forall(x => phase(st.f.get(x)) != 4)
  val w_no_counter_registered: bool = SIDES.forall(x => phase(st.f.get(x)) != 5)
  val w_no_counter_lapsed: bool = SIDES.forall(x => phase(st.f.get(x)) != 6)
  val w_no_start_lapsed: bool = st.g.lapsedStarts == 0
  val w_no_window_over: bool = SIDES.forall(x => phase(st.f.get(x)) != 7)
  val w_no_finalize: bool = st.g.finals == 0
  val w_no_second_finalize: bool = st.g.finals < 2
  val w_no_skipped_start: bool = st.g.skipsStart == 0
  val w_no_settle: bool = not(st.chEpoch > 1 and st.g.finals == 0)      // an epoch move with no dispute (a co-signed settlement)
  // the premise of `no_lock` is reachable: a side that has heard everything and sees the window over
  val w_no_solo_premise: bool = SIDES.forall(x => not(and { st.disp.on, st.disp.over, st.up.get(x), st.seen.get(x) == st.log.length(), not(st.fresh.get(x)), st.f.get(x).sOn or st.f.get(x).aOn }))
}
