// Scenario tests for dispute.qnt: exact schedules, each one an audit finding of the dispute code (#159, #160 and the two audits
// before) or the baseline they depart from. A scenario runs under every switch variant (dispute_today.qnt ... dispute_all.qnt) and
// states what that variant does: the assertions read the switches, so the same schedule shows the bug where a fix is missing and the
// refusal where it is present.
//
//   quint test dispute_test.qnt --main today_test --backend typescript        (and freeze_test, live_test, decided_test, accept_test, all_test)
//
// A test may move the clock with `jump`, which the model itself never does: time passes in the model only when nothing is owed.

module scn {
  const SW_FREEZE: bool
  const SW_LIVE: bool
  const SW_ACCEPT: bool
  const SW_NOTICE: bool
  const SW_PAY: int

  import dispute(FREEZE = SW_FREEZE, LIVE = SW_LIVE, ACCEPT = SW_ACCEPT, NOTICE = SW_NOTICE, PAY = SW_PAY).* from "./dispute"

  action jump(t: int): bool = st' = { ...st, now: t }
  action check(c: bool): bool = all { assert(c), st' = st }

  // L proposes n2 and it commits on both sides: the first co-signed frame of the epoch.
  // L then proposes n3; R commits it, and its ack is held back: R holds a proof L does not.
  // A dispute L starts now rests on n2, the newest proof L holds, while R holds n3.
  run staleStartCounteredTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(seal(Left)).then(receive)
      .then(check(st.hold.get(Left) == 2 and st.hold.get(Right) == 3))
      .then(opStart(Left)).then(duty(Left)).then(landStart(Left))
      .then(hear(Right)).then(duty(Right))
      .then(check(st.f.get(Right).cOn and st.f.get(Right).cNonce == 3 and phase(st.f.get(Right)) == 4))
      .then(landCounter(Right))
      .then(hear(Left)).then(hear(Left)).then(hear(Right)).then(duty(Left)).then(duty(Right))
      .then(check(phase(st.f.get(Right)) == 5 and st.f.get(Left).sCtd == 3))
      .then(jump(5)).then(windowOver)
      .then(hear(Left)).then(hear(Right)).then(duty(Left)).then(duty(Right))
      .then(landFinal(Right))
      .then(check(st.g.settledLast == 3 and not(st.g.lostNewest) and st.g.finals == 1))
  }

  // Alice's ack is late: the dispute's window passes while R's frame n4 (sealed after the counter) commits on both sides.
  // Without FREEZE R seals it, L commits it, and the chain pays the counter, n3: n4 is newer and co-signed and nobody can enforce it.
  // With FREEZE R, which heard the dispute, seals nothing.
  run frameAfterTheCounterTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(seal(Left)).then(receive)
      .then(opStart(Left)).then(duty(Left)).then(landStart(Left))
      .then(hear(Right)).then(duty(Right)).then(landCounter(Right))
      .then(hear(Right)).then(duty(Right))
      .then(ack)
      .then(if (FREEZE) check(quiet(st.f.get(Right)))
            else seal(Right).then(receive).then(ack))
      .then(check(if (FREEZE) st.comm.get(Right) == 3 else st.comm.get(Right) == 4))
      .then(jump(5)).then(windowOver)
      .then(hear(Left)).then(hear(Left)).then(hear(Left)).then(hear(Right))
      .then(duty(Left)).then(duty(Right))
      .then(landFinal(Right))
      .then(check(st.g.settledLast == 3 and st.g.lostNewest == not(FREEZE)))
  }

  // The Host's simulation reverts R's counter for a transient reason. Today the Entity is told it lapsed and never asks again, so the
  // starter finalizes with its older proof after the window: the newest co-signed state, held by a live R, loses. With LIVE the
  // lapse is not told, the counter is asked again at the next frame and registers inside the window.
  run counterLapsesTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(seal(Left)).then(receive)
      .then(opStart(Left)).then(duty(Left)).then(landStart(Left))
      .then(hear(Right)).then(duty(Right))
      .then(dropCounter(Right))
      .then(check(if (LIVE) not(st.f.get(Right).cDead) else st.f.get(Right).cDead))
      .then(if (LIVE) duty(Right).then(landCounter(Right)) else check(true))
      .then(hear(Left)).then(if (LIVE) hear(Left).then(hear(Right)) else check(true)).then(duty(Left)).then(if (LIVE) duty(Right) else check(true))
      .then(jump(5)).then(windowOver)
      .then(hear(Left)).then(hear(Right)).then(duty(Left)).then(duty(Right))
      .then(if (LIVE) landFinal(Right) else landFinal(Left))
      .then(check(if (LIVE) st.g.settledLast == 3 and not(st.g.lostNewest) else st.g.settledLast == 2 and st.g.lostNewest))
  }

  // R counters, the counter registers, and R goes down for good. The window ends. Today the starter L heard the counter and asks
  // for nothing: the Account stays locked as long as R is down. With LIVE it finalizes with the counter's proof.
  run starterNeverFinalizesTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(seal(Left)).then(receive)
      .then(opStart(Left)).then(duty(Left)).then(landStart(Left))
      .then(hear(Right)).then(duty(Right)).then(landCounter(Right))
      .then(crash(Right))
      .then(hear(Left)).then(hear(Left)).then(duty(Left))
      .then(jump(5)).then(windowOver)
      .then(hear(Left)).then(duty(Left))
      .then(check(phase(st.f.get(Left)) == 7 and st.g.finals == 0))
      .then(check(if (LIVE) st.askF.get(Left).on else not(st.askF.get(Left).on)))
      .then(check(if (LIVE) no_lock_left else not(no_lock_left)))
      .then(if (LIVE) landFinal(Left) else check(true))
      .then(check(if (LIVE) st.g.settledLast == 3 and st.g.finals == 1 else st.g.finals == 0))
  }

  // L starts from the proof both hold and goes down for good. R holds nothing newer, so it has nothing to counter; the window ends.
  // Today R asks for nothing, though the contract lets the non-starter take the opening state at once: locked while L is down.
  // With ACCEPT R finalizes with it.
  run nothingNewerTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(opStart(Left)).then(duty(Left)).then(landStart(Left))
      .then(crash(Left))
      .then(hear(Right)).then(duty(Right))
      .then(check(phase(st.f.get(Right)) == 3))
      .then(jump(5)).then(windowOver)
      .then(hear(Right)).then(duty(Right))
      .then(check(if (ACCEPT) st.askF.get(Right).on else not(st.askF.get(Right).on)))
      .then(check(if (ACCEPT) no_lock_right else not(no_lock_right)))
      .then(if (ACCEPT) landFinal(Right) else check(true))
      .then(check(if (ACCEPT) st.g.settledLast == 2 and st.g.finals == 1 else st.g.finals == 0))
  }

  // The finalize gap. R finalizes with the counter and L has not yet heard of it. L seals a frame in its old epoch. R has heard of the
  // finalize or not: if it has, it refuses the old epoch's frame. If R has not heard, it commits it, and it is zeroed at rebase.
  // With FREEZE R is quiet from the moment it heard the dispute, so the frame is refused either way.
  run finalizeGapTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(seal(Left)).then(receive)
      .then(opStart(Left)).then(duty(Left)).then(landStart(Left))
      .then(hear(Right)).then(duty(Right)).then(landCounter(Right))
      .then(ack)
      .then(jump(5)).then(windowOver)
      .then(hear(Left)).then(hear(Left)).then(hear(Left)).then(duty(Left))
      .then(hear(Right)).then(hear(Right)).then(duty(Right))
      .then(landFinal(Right))
      // L has not heard the finalize (its Entity sealed under epoch 1); R has not heard it either
      .then(if (FREEZE) check(quiet(st.f.get(Left)))
            else seal(Left).then(receive).then(ack))
      .then(check(if (FREEZE) st.comm.get(Left) == 3 else st.comm.get(Left) == 4))
      .then(hear(Left)).then(hear(Right))
      .then(check(if (FREEZE) not(st.g.zeroed.get(Left)) else st.g.zeroed.get(Left) and st.g.zeroed.get(Right)))
      .then(check(not(no_silent_zeroing) == not(FREEZE)))
  }

  // L seals n3 and then starts its dispute from n2. R, which has not heard of the dispute, commits n3 and goes down; the ack reaches L.
  // The window ends with R still down: the starter finalizes with n2 and the payment both sides committed is zeroed. R was down, so the
  // newest-wins property excuses the chain; the zeroing is nobody's notice today, with FREEZE too (the frame was sealed before anyone
  // heard of the dispute). Only NOTICE tells it.
  run sealedBeforeTheStartTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(seal(Left))
      .then(opStart(Left)).then(duty(Left))
      .then(receive).then(crash(Right)).then(ack)
      .then(landStart(Left)).then(hear(Left)).then(duty(Left))
      .then(check(st.comm.get(Left) == 3 and st.hold.get(Right) == 3 and st.disp.n == 2))
      .then(jump(5)).then(windowOver)
      .then(hear(Left)).then(duty(Left))
      .then(landFinal(Left))
      .then(check(st.g.settledLast == 2 and not(st.g.lostNewest)))
      .then(restart(Right)).then(hear(Right)).then(hear(Right)).then(hear(Right)).then(hear(Left))
      .then(check(st.g.zeroed.get(Left) and st.g.zeroed.get(Right)))
      .then(check(st.g.told.get(Left) == NOTICE))
  }

  // Both sides start at once. The chain keeps the first and skips the second without telling anybody: the loser's record has no window.
  run bothStartTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(opStart(Left)).then(opStart(Right))
      .then(landStart(Right)).then(landStart(Left))
      .then(check(st.disp.starter == Right and st.g.skipsStart == 1))
      .then(hear(Left)).then(hear(Right))
      .then(check(phase(st.f.get(Left)) == 3 or st.f.get(Left).sOn))
      .then(check(st.f.get(Left).sOn and not(st.f.get(Left).sWin) and st.f.get(Left).aOn))
      .then(check(phase(st.f.get(Right)) == 2))
  }

  // A co-signed settlement moves the epoch while L's start is on its way. The chain skips the start (the epoch moved) and tells nobody;
  // L's record has no window until L hears the epoch move, which forgets it. L is frozen from the co-signing to that moment.
  run startAfterTheEpochMovedTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(opStart(Left)).then(settle).then(landStart(Left))
      .then(check(st.g.skipsStart == 1 and not(st.disp.on)))
      .then(check(phase(st.f.get(Left)) == 1 and st.frz.get(Left)))
      .then(hear(Left))
      .then(check(phase(st.f.get(Left)) == 0 and not(st.frz.get(Left)) and st.f.get(Left).epoch == 2))
  }
  // A payment sealed before the dispute reaches the other side after it. R, in the dispute L started, refuses the frame: its Entity keeps no proof
  // from it (the proofs map is written by a committed round only), but R holds L's signature on it, and a finalize built outside the Entity
  // (the non-starter's finalize with a signature, no counter) pays by it: the finalized body already paid the payment. L hears the epoch move with
  // the frame still pending. PAY=1 (#162 8f82733df): L seals it again in the new epoch, R commits it, and the payment is paid twice.
  // PAY=2: L drops it, never seals it again.
  run signedFrameRefusedTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(seal(Left))
      .then(opStart(Left)).then(duty(Left)).then(landStart(Left))
      .then(hear(Right))
      .then(receive)
      .then(if (PAY == 0) check(true)
            else check(st.pend.stage == 2 and st.hold.get(Right) == 2 and st.g.kept.get(Right) == 3 and st.comm.get(Right) == 2)
              .then(duty(Right))
              .then(check(not(st.f.get(Right).cOn)))
              .then(landSigFinal(Right))
              .then(check(st.g.settledLast == 3 and st.g.chain.size() == 1 and st.g.sigs == 1))
              .then(hear(Left)).then(hear(Left)).then(hear(Right))
              .then(check(if (PAY == 1) st.g.owes.get(Left) == 2 else st.g.owes.get(Left) == 0))
              .then(if (PAY == 1) seal(Left).then(receive).then(check(st.g.double))
                    else check(not(st.pend.on) and not(st.g.double))))
  }

  // The same frame, but the refusal comes back to L as retryable before L hears of the dispute: L rolls the frame back and its payment goes back
  // to the mempool, while R still holds L's signature on the frame. R's finalize pays by it. PAY=1 and 2 (a node drops only the frame it still
  // has pending): L seals the payment again in the new epoch, R commits it, paid twice (Review A on #162 61e47255). PAY=3 (a node drops the
  // payment of every frame it signed in the epoch, a rolled-back one too): dropped.
  run rolledBackFrameTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(seal(Left))
      .then(opStart(Left)).then(duty(Left)).then(landStart(Left))
      .then(hear(Right))
      .then(receive)
      .then(if (PAY == 0) check(true)
            else rollback
              .then(check(not(st.pend.on) and st.g.owes.get(Left) == 2 and st.g.kept.get(Right) == 3))
              .then(duty(Right)).then(landSigFinal(Right))
              .then(check(st.g.chain.size() == 1))
              .then(hear(Left)).then(hear(Left)).then(hear(Right))
              .then(check(if (PAY <= 2) st.g.owes.get(Left) == 2 else st.g.owes.get(Left) == 0))
              .then(if (PAY <= 2) seal(Left).then(receive).then(check(st.g.double))
                    else check(not(st.pend.on) and not(st.g.double))))
  }

  // The same frame, committed by R before it heard of the dispute and acked too late: R holds it as a committed frame, L keeps it pending
  // and the re-ack brings the rebased state: nothing is sealed again, in either variant.
  run committedFrameAckLostTest = {
    init
      .then(seal(Left)).then(receive).then(ack)
      .then(seal(Left)).then(receive)
      .then(opStart(Left)).then(duty(Left)).then(landStart(Left))
      .then(hear(Right)).then(duty(Right)).then(landCounter(Right))
      .then(hear(Left)).then(hear(Left)).then(hear(Right)).then(duty(Left)).then(duty(Right))
      .then(jump(5)).then(windowOver)
      .then(hear(Left)).then(hear(Right)).then(duty(Left)).then(duty(Right))
      .then(landFinal(Right))
      .then(hear(Left)).then(hear(Right))
      .then(check(st.g.owes.get(Left) == 0 and not(st.g.double)))
  }
}

module today_test { import scn(SW_FREEZE = false, SW_LIVE = false, SW_ACCEPT = false, SW_NOTICE = false, SW_PAY = 0).* from "./dispute_test" }
module freeze_test { import scn(SW_FREEZE = true, SW_LIVE = false, SW_ACCEPT = false, SW_NOTICE = false, SW_PAY = 0).* from "./dispute_test" }
module live_test { import scn(SW_FREEZE = false, SW_LIVE = true, SW_ACCEPT = false, SW_NOTICE = false, SW_PAY = 0).* from "./dispute_test" }
module decided_test { import scn(SW_FREEZE = true, SW_LIVE = true, SW_ACCEPT = false, SW_NOTICE = false, SW_PAY = 0).* from "./dispute_test" }
module accept_test { import scn(SW_FREEZE = true, SW_LIVE = true, SW_ACCEPT = true, SW_NOTICE = false, SW_PAY = 0).* from "./dispute_test" }
module all_test { import scn(SW_FREEZE = true, SW_LIVE = true, SW_ACCEPT = true, SW_NOTICE = true, SW_PAY = 0).* from "./dispute_test" }
module pay_test { import scn(SW_FREEZE = true, SW_LIVE = true, SW_ACCEPT = true, SW_NOTICE = true, SW_PAY = 1).* from "./dispute_test" }
module payall_test { import scn(SW_FREEZE = true, SW_LIVE = true, SW_ACCEPT = true, SW_NOTICE = true, SW_PAY = 3).* from "./dispute_test" }
module paydrop_test { import scn(SW_FREEZE = true, SW_LIVE = true, SW_ACCEPT = true, SW_NOTICE = true, SW_PAY = 2).* from "./dispute_test" }
