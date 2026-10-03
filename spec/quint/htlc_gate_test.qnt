// Scenario tests for htlc.qnt's clock: the contract counts seconds, the hub's gates count J heights. The signed second of a deadline is a line through
// an anchor block plus a slack (R-DEADLINE-TIMESTAMP), so a reveal up to SLK ticks after the height deadline still pays the clause on D, while the hub's
// resolve and expiry gates (account/clause/clock.ts, entity/frame.ts) refuse at the height. The hub hears an event PD ticks after it landed (depth plus
// poll), and an expiry waits for a reserve RSV.
//
//   height gate   the hub's claim on U is a frame the height gate refuses after TU:      safe iff HOP >= SLK + PD + LAG
//   chain claim   the hub's claim is a chain claim, counted until the lock's second:     safe iff HOP >= PD + LAG  and  HOP + RSV >= SLK + PD
//                 (the slack cancels: the clause on U gets the same slack as the clause on D; the reserve covers the hearing)
//   LAG is the landing time of a J transaction (here 1). `lateRevealRaceTest` runs the worst schedule and asserts the formula in both directions,
//   so a variant that breaks it fails the test, and a variant that keeps it must pass.
//
//   quint test htlc_gate_test.qnt --main hgate2_htlc_gate_test --backend typescript

module hgate {
  const SW_HOP: int
  const SW_XREV: bool
  const SW_TSEE: bool
  const SW_BACK: bool
  const SW_SLK: int
  const SW_PD: int
  const SW_RSV: int
  const SW_CHAIN: bool

  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = SW_HOP, XREV = SW_XREV, TSEE = SW_TSEE, BACK = SW_BACK,
              SLK = SW_SLK, PD = SW_PD, RSV = SW_RSV, CHAIN = SW_CHAIN).* from "./htlc"

  pure def later(t: int, n: int): int = if (t > n) t else n
  action goto(t: int): bool = st' = { ...st, now: later(t, st.now) }
  action wait(d: int): bool = st' = { ...st, now: st.now + d }
  action check(c: bool): bool = all { assert(c), st' = st }

  // the formula under test
  pure val PRED: bool =
    if (SW_BACK) true
    else if (SW_CHAIN) SW_HOP >= SW_PD + LAG and SW_HOP + SW_RSV >= SW_SLK + SW_PD
    else SW_HOP >= SW_SLK + SW_PD + LAG

  // The payer's earliest expiry, the hub's earliest hearing, the claim the hub asks for lands at the latest. The adversary acts first whenever it may.
  action chase(e: int): bool =
    if (st.knows)
      askClaim.then(
        if (not(SW_CHAIN) and e <= st.now + LAG) goto(e).then(expireU)
        else goto(st.now + LAG).then(landClaim))
    else check(true)

  action race: bool = {
    val h = st.now + SW_PD
    val e = TU + SW_RSV + 1
    if (SW_BACK) check(true)
    else if (e <= h) goto(e).then(expireU)
    else goto(h).then(hear(Hub)).then(hear(Payee)).then(chase(e))
  }

  action closeEnd: bool =
    if (st.u != 0) check(true)
    else if (SW_BACK) goto(st.revealedAt + SW_PD).then(claimByRegistry)
    else goto(TUX + SW_PD + SW_RSV + 2).then(expireU)

  // The hub starts a dispute on D; the payee reveals as late as the chain still counts it (TD + SLK, past the height deadline when SLK > 0); the
  // finalize pays the clause on D. Whether the hub collects on U depends on the room the hop leaves.
  run lateRevealRaceTest = {
    init
      .then(askStart(Hub)).then(landStart(Hub)).then(wait(SW_PD)).then(hear(Hub)).then(hear(Payee))
      .then(askReveal).then(goto(TDX)).then(if (SW_XREV) landRevealDirect else landReveal)
      .then(check(st.revealedAt == TDX and not(st.lateReveal)))
      .then(race)
      .then(goto(finTime(st.disp))).then(landFinal)
      .then(check(st.paidChain == 1))
      .then(closeEnd)
      .then(check(paid_once and route_safe == PRED))
  }

  // One tick past the second the contract counts: the clause on D is lost to the payee, and the hub is not out of pocket in any variant.
  run revealPastTheSecondTest = {
    init
      .then(askStart(Hub)).then(landStart(Hub)).then(wait(SW_PD)).then(hear(Hub)).then(hear(Payee))
      .then(askReveal).then(goto(TDX + 1)).then(if (SW_XREV) landRevealDirect else landReveal)
      .then(check(st.lateReveal))
      .then(goto(finTime(st.disp))).then(landFinal)
      .then(check(st.paidChain == 0))
      .then(if (SW_BACK) goto(TUX + SW_PD).then(if (regShows(st)) claimByRegistry else expireU) else goto(TUX + SW_PD + SW_RSV + 2).then(expireU))
      .then(check(paid_once and route_safe))
  }

  // The hub hears an event PD ticks after it landed, not before: depth and poll are real.
  run hearingWaitsForDepthTest = {
    init.then(if (SW_PD == 0) check(true) else
      askStart(Hub).then(landStart(Hub)).then(hear(Hub)).fail())
  }

  // A chain claim: while the hub knows the secret and the lock's second has not passed, the payer cannot make it co-sign the expiry, whatever the
  // clock says (the hub claims instead).
  run chainHubRefusesExpiryWhileClaimingTest = {
    val e = TU + SW_RSV + 1
    init.then(if (not(SW_CHAIN) or e > TUX) check(true) else
      askStart(Hub).then(landStart(Hub)).then(wait(SW_PD)).then(hear(Hub)).then(hear(Payee))
        .then(askReveal).then(goto(TDX)).then(landReveal).then(goto(st.now + SW_PD)).then(hear(Hub)).then(hear(Payee))
        .then(check(st.knows))
        .then(goto(e)).then(expireU).fail())
  }

  // The backstop reads the registry at depth: before its read covers the lock's second, the hub does not co-sign the expiry, even if nothing was
  // revealed; after, it may.
  run backstopWaitsForDepthTest = {
    init.then(if (not(SW_BACK) or SW_PD == 0) check(true) else
      goto(TU + SW_RSV + 1).then(expireU).fail())
  }
  run backstopExpiresWhenNothingShownTest = {
    init.then(if (not(SW_BACK)) check(true) else
      goto(TUX + SW_PD + SW_RSV + 1).then(expireU).then(check(st.u == 2)))
  }
}

module hgate1_htlc_gate_test { import hgate(SW_HOP = 1, SW_XREV = false, SW_TSEE = false, SW_BACK = false, SW_SLK = 2, SW_PD = 0, SW_RSV = 0, SW_CHAIN = false).* from "./htlc_gate_test" }
module hgate2_htlc_gate_test { import hgate(SW_HOP = 2, SW_XREV = false, SW_TSEE = false, SW_BACK = false, SW_SLK = 2, SW_PD = 0, SW_RSV = 0, SW_CHAIN = false).* from "./htlc_gate_test" }
module hgate3_htlc_gate_test { import hgate(SW_HOP = 3, SW_XREV = false, SW_TSEE = false, SW_BACK = false, SW_SLK = 2, SW_PD = 0, SW_RSV = 0, SW_CHAIN = false).* from "./htlc_gate_test" }
module hpoll2_htlc_gate_test { import hgate(SW_HOP = 2, SW_XREV = false, SW_TSEE = false, SW_BACK = false, SW_SLK = 0, SW_PD = 2, SW_RSV = 0, SW_CHAIN = false).* from "./htlc_gate_test" }
module hpoll3_htlc_gate_test { import hgate(SW_HOP = 3, SW_XREV = false, SW_TSEE = false, SW_BACK = false, SW_SLK = 0, SW_PD = 2, SW_RSV = 0, SW_CHAIN = false).* from "./htlc_gate_test" }
module hchain0_htlc_gate_test { import hgate(SW_HOP = 2, SW_XREV = false, SW_TSEE = false, SW_BACK = false, SW_SLK = 2, SW_PD = 1, SW_RSV = 0, SW_CHAIN = true).* from "./htlc_gate_test" }
module hchain1_htlc_gate_test { import hgate(SW_HOP = 2, SW_XREV = false, SW_TSEE = false, SW_BACK = false, SW_SLK = 2, SW_PD = 1, SW_RSV = 1, SW_CHAIN = true).* from "./htlc_gate_test" }
module hchain2_htlc_gate_test { import hgate(SW_HOP = 1, SW_XREV = false, SW_TSEE = false, SW_BACK = false, SW_SLK = 2, SW_PD = 0, SW_RSV = 2, SW_CHAIN = true).* from "./htlc_gate_test" }
module hback_htlc_gate_test { import hgate(SW_HOP = 2, SW_XREV = true, SW_TSEE = false, SW_BACK = true, SW_SLK = 1, SW_PD = 2, SW_RSV = 0, SW_CHAIN = false).* from "./htlc_gate_test" }
module hall_htlc_gate_test { import hgate(SW_HOP = 3, SW_XREV = false, SW_TSEE = false, SW_BACK = false, SW_SLK = 2, SW_PD = 1, SW_RSV = 0, SW_CHAIN = false).* from "./htlc_gate_test" }
module hstall_htlc_gate_test { import hgate(SW_HOP = 2, SW_XREV = false, SW_TSEE = false, SW_BACK = false, SW_SLK = 0, SW_PD = 4, SW_RSV = 0, SW_CHAIN = false).* from "./htlc_gate_test" }
module hstall5_htlc_gate_test { import hgate(SW_HOP = 5, SW_XREV = false, SW_TSEE = false, SW_BACK = false, SW_SLK = 0, SW_PD = 4, SW_RSV = 0, SW_CHAIN = false).* from "./htlc_gate_test" }
