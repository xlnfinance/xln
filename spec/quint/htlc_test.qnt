// Scenario tests for htlc.qnt: the two money bugs of the freeze audit (#162, F1 and F2) as exact schedules, and the baselines they depart from.
// Each runs under the four variants; assertions read the switches, so a schedule shows the loss where a fix is missing and the refusal
// where it is present.
//
//   quint test htlc_test.qnt --main today_htlc_test --backend typescript    (and see_htlc_test, dissolve_htlc_test, both_htlc_test)
//
// A test may move the clock with `jump`; the model itself never does: time passes only when nothing is owed.

module hscn {
  const SW_SEE: bool
  const SW_DISSOLVE: bool
  const SW_HOP: int

  import htlc(SEE = SW_SEE, DISSOLVE = SW_DISSOLVE, HOP = SW_HOP).* from "./htlc"

  action jump(t: int): bool = st' = { ...st, now: t }
  action check(c: bool): bool = all { assert(c), st' = st }
  action closeU: bool = if (st.u == 0) jump(TU + 1).then(expireU) else check(true)

  // The baseline: no dispute. The payee releases by frame, the hub learns the secret from it and claims upstream. One unit out, one in.
  run releaseByFrameTest = {
    init
      .then(sendRelease).then(receive).then(ack)
      .then(check(st.knows and st.paidFrame == 1 and not(st.v.get(Hub).hold) and not(st.v.get(Payee).hold)))
      .then(askClaim).then(landClaim)
      .then(check(st.u == 1 and st.collected == 1 and paid_once and route_safe))
  }

  // F1. The hub starts a dispute on D; the payee, quiet, reveals the secret on the chain, the only way left to be paid. Without SEE the
  // hub never learns it (the watcher ignores SecretRevealed): the chain pays Y at the finalize, the lock on U expires, the hub is out one unit.
  run chainRevealUnheardTest = {
    init
      .then(askStart(Hub)).then(landStart(Hub)).then(hear(Hub)).then(hear(Payee))
      .then(check(quiet(st.v.get(Hub)) and quiet(st.v.get(Payee))))
      .then(askReveal).then(landReveal).then(hear(Hub)).then(hear(Payee))
      .then(check(st.knows == SW_SEE))
      .then(if (SW_SEE) askClaim.then(landClaim) else check(true))
      .then(jump(TD)).then(landFinal).then(hear(Hub)).then(hear(Payee))
      .then(check(st.paidChain == 1))
      .then(closeU)
      .then(check(paid_once and route_safe == SW_SEE and st.collected == (if (SW_SEE) 1 else 0)))
  }

  // F2. The same dispute; the finalize pays the carried hold. A release the payee queued while quiet is sealed after the epoch move: the
  // rebase kept the hold, so the hub commits it and Y is paid twice. With DISSOLVE the hold is gone at the epoch move and the payee has
  // nothing to release.
  run releaseAfterFinalizeTest = {
    init
      .then(askStart(Payee)).then(landStart(Payee)).then(hear(Hub)).then(hear(Payee))
      .then(check(not(st.v.get(Payee).hold == false)))
      .then(askReveal).then(landReveal).then(hear(Hub)).then(hear(Payee))
      .then(if (SW_SEE) askClaim.then(landClaim) else check(true))
      .then(jump(TD)).then(landFinal).then(hear(Hub)).then(hear(Payee))
      .then(check(st.paidChain == 1 and st.v.get(Hub).epoch == 2 and st.v.get(Payee).epoch == 2))
      .then(check(st.v.get(Payee).hold == not(SW_DISSOLVE) and st.v.get(Hub).hold == not(SW_DISSOLVE)))
      .then(if (SW_DISSOLVE) check(true) else sendRelease.then(receive).then(ack))
      .then(closeU)
      .then(check(st.paidFrame == (if (SW_DISSOLVE) 0 else 1)))
      .then(check(paid_once == SW_DISSOLVE and route_safe == (SW_SEE and SW_DISSOLVE)))
  }

  // The payee never reveals: the finalize refunds the hold to the hub, nothing is paid out, the lock on U expires. Safe everywhere.
  run refundWhenNotRevealedTest = {
    init
      .then(askStart(Hub)).then(landStart(Hub)).then(hear(Hub)).then(hear(Payee))
      .then(jump(TD)).then(landFinal).then(hear(Hub)).then(hear(Payee))
      .then(check(st.paidChain == 0 and st.v.get(Hub).epoch == 2 and st.v.get(Hub).hold == not(SW_DISSOLVE)))
      .then(closeU)
      .then(check(out(st) == 0 and st.collected == 0 and paid_once and route_safe))
  }

  // The secret lands one tick after TD, before the finalize: the clause is lost, the chain refunds, the hub is not out of pocket.
  run lateRevealTest = {
    init
      .then(askStart(Hub)).then(landStart(Hub)).then(hear(Hub)).then(hear(Payee))
      .then(askReveal).then(jump(TD + 1)).then(landReveal).then(landFinal).then(hear(Hub)).then(hear(Hub)).then(hear(Payee)).then(hear(Payee))
      .then(check(st.lateReveal and st.paidChain == 0))
      .then(closeU)
      .then(check(paid_once and route_safe))
  }

  // The hub committed the payee's release and the ack is on its way when the payee starts a dispute from the proof that still carries
  // the hold. The chain pays the carried hold and the committed frame is zeroed: one unit out. The hub learned the secret from the frame
  // and claims. Safe everywhere: the zeroing is the payee's loss only if it did not reveal (dispute.qnt's gap), not the hub's.
  run committedReleaseThenDisputeTest = {
    init
      .then(sendRelease).then(receive)
      .then(askStart(Payee)).then(landStart(Payee)).then(hear(Hub)).then(hear(Payee))
      .then(askClaim).then(landClaim)
      .then(askReveal).then(landReveal).then(hear(Hub)).then(hear(Payee))
      .then(jump(TD)).then(landFinal).then(hear(Hub)).then(hear(Payee))
      .then(check(st.paidFrame == 0 and st.paidChain == 1 and st.u == 1 and st.collected == 1 and paid_once and route_safe))
  }

  // The dispute starts late: the window ends after TU, so the finalize lands after the lock on U expired. The reveal is on the chain at TD;
  // the hub must claim before TU. Without SEE it never does and the finalize pays the payee after the expiry (the property is checked after
  // U closes, and again after the finalize).
  run finalizeAfterTheUpstreamExpiryTest = {
    init
      .then(jump(TD - 1)).then(askStart(Hub)).then(landStart(Hub)).then(hear(Hub)).then(hear(Payee))
      .then(askReveal).then(landReveal).then(hear(Hub)).then(hear(Payee))
      .then(if (SW_SEE) askClaim.then(landClaim) else check(true))
      .then(jump(TU + 1)).then(closeU)
      .then(check(st.u == (if (SW_SEE) 1 else 2)))
      .then(jump(st.disp.timeout)).then(landFinal)
      .then(check(st.paidChain == 1 and st.now > TU and route_safe == SW_SEE and paid_once))
  }

  // E3: the upstream deadline leaves room for the claim. The secret lands on the chain at TD, the hub hears it and asks, and the claim lands one
  // tick later. With HOP >= 1 that is within TU and the hub collects; with HOP = 0 it is after TU, the lock has expired to the payer and the
  // finalize pays the payee: the hub is out one unit even with both fixes (a floor of HOP >= REACT keeps a margin for a slower landing).
  run claimNeedsRoomTest = {
    init
      .then(askStart(Hub)).then(landStart(Hub)).then(hear(Hub)).then(hear(Payee))
      .then(askReveal).then(jump(TD)).then(landReveal).then(hear(Hub)).then(hear(Payee))
      .then(if (SW_SEE) askClaim else check(true))
      .then(jump(TD + 1)).then(if (SW_SEE) landClaim else check(true))
      .then(landFinal).then(hear(Hub)).then(hear(Payee))
      .then(closeU)
      .then(check(st.paidChain == 1 and route_safe == (SW_SEE and SW_HOP >= 1)))
  }
}

module today_htlc_test { import hscn(SW_SEE = false, SW_DISSOLVE = false, SW_HOP = 2).* from "./htlc_test" }
module see_htlc_test { import hscn(SW_SEE = true, SW_DISSOLVE = false, SW_HOP = 2).* from "./htlc_test" }
module dissolve_htlc_test { import hscn(SW_SEE = false, SW_DISSOLVE = true, SW_HOP = 2).* from "./htlc_test" }
module both_htlc_test { import hscn(SW_SEE = true, SW_DISSOLVE = true, SW_HOP = 2).* from "./htlc_test" }
module hop0_htlc_test { import hscn(SW_SEE = true, SW_DISSOLVE = true, SW_HOP = 0).* from "./htlc_test" }
