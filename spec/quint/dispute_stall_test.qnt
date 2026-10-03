// Scenario tests for the Host's hold of an Account's events (R-WATCH-STALL, #171) in dispute.qnt: the Entity hears an event STALL ticks after the chain
// logged it. Every other scenario of dispute_test.qnt assumes it hears at once, so these run apart, under their own variants:
//
//   quint test dispute_stall_test.qnt --main stall3_test --backend typescript
//
// W = 4 and LAG = 1 (dispute.qnt): the counter to a stale start registers iff STALL + LAG < W, and a transient revert of its ask costs one more LAG.

module stallscn {
  const SW_STALL: int

  import dispute(FREEZE = true, LIVE = true, ACCEPT = true, NOTICE = true, PAY = 0, STALL = SW_STALL).* from "./dispute"

  action jump(t: int): bool = st' = { ...st, now: t }
  action check(c: bool): bool = all { assert(c), st' = st }
  action hearIf(s: Side): bool = if (st.seen.get(s) < st.log.length()) hear(s) else check(true)

  // L starts with the proof it holds while R holds a newer one. R hears the start STALL ticks after it landed, asks the counter, and the chain lands
  // it within LAG of the ask, inside the window if it is still open. With a longer hold the starter finalizes with the stale proof and R's newest
  // frame is lost. The Host's hold is bounded by the Entity's locks (`lastHeard`), not by this window: nothing in the loop ties the two.
  run stalledStartTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(seal(Left)).then(receive)
      .then(opStart(Left)).then(duty(Left)).then(landStart(Left))
      .then(jump(1 + SW_STALL)).then(hear(Right)).then(duty(Right))
      .then(jump(1 + SW_STALL + LAG)).then(landCounter(Right))
      .then(check((st.disp.ctr == 3) == (SW_STALL + LAG < W)))
      .then(jump(1 + W + SW_STALL + LAG)).then(windowOver)
      .then(jump(st.now + SW_STALL))
      .then(hearIf(Left)).then(hearIf(Left)).then(hearIf(Left)).then(hearIf(Right)).then(hearIf(Right)).then(hearIf(Right))
      .then(duty(Left)).then(duty(Right))
      .then(if (st.askF.get(Left).on) landFinal(Left) else landFinal(Right))
      .then(check(st.g.lostNewest == (SW_STALL + LAG >= W)))
  }

  // The hold is real: the start is not heard before STALL ticks have passed.
  run stalledHearingWaitsTest = {
    init.then(if (SW_STALL == 0) check(true) else
      seal(Left).then(receive).then(ack)
        .then(opStart(Left)).then(duty(Left)).then(landStart(Left))
        .then(hear(Right)).fail())
  }
}

module stall1_test { import stallscn(SW_STALL = 1).* from "./dispute_stall_test" }
module stall2_test { import stallscn(SW_STALL = 2).* from "./dispute_stall_test" }
module stall3_test { import stallscn(SW_STALL = 3).* from "./dispute_stall_test" }
