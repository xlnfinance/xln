// Scenario tests for runtime.qnt: what a crash between two steps of a frame costs.
// Run with: quint test runtime_test.qnt --backend typescript
module runtime_test {
  import runtime.* from "./runtime"

  // The plain frame: three steps, the frame leaves last.
  run frameIsThreeStepsTest =
    init
    .then(arrive(cKey(1)))
    .then(apply)
    .expect(and { phase == Applied, net == Set(), acked == Set() })
    .then(persist)
    .expect(and { phase == Durable, acked == Set(cKey(1)), net == Set() })
    .then(send)
    .expect(and { phase == Idle, net.size() == 1, safe })

  // A crash before the frame is durable loses it and nothing has left: the next frame at that height may differ.
  run crashBeforeDurableLosesNothingSentTest =
    init
    .then(arrive(cKey(1)))
    .then(apply)
    .then(crash)
    .then(arrive(pKey(1))).then(arrive(cKey(1)))
    .then(apply).then(persist).then(send)
    .expect(and { net.size() == 1, disk.applied == [pKey(1), cKey(1)], no_equivocation, safe })

  // A crash after the frame is durable but before it left: the restart sends the same frame again.
  run crashAfterDurableResendsTest =
    init
    .then(arrive(cKey(1)))
    .then(apply).then(persist)
    .then(crash)
    .expect(and { net.size() == 1, mem == disk, phase == Idle })
    .then(arrive(cKey(2)))
    .then(apply).then(persist).then(send)
    .expect(and { net.size() == 2, disk.h == 2, no_equivocation, safe })

  // A chain event is read, the runtime crashes before applying it: the cursor is where it was, the event is read again.
  run chainEventSurvivesACrashTest =
    init
    .then(chainEmit).then(chainEmit)
    .then(watch)
    .then(crash)
    .then(watch)
    .then(apply).then(persist).then(send)
    .then(watch)
    .then(apply).then(persist).then(send)
    .expect(and { disk.applied == [jKey(1), jKey(2)], disk.cursor == 2, safe })

  // One frame applies what is due in canonical order, whatever the arrival order.
  run canonicalOrderTest =
    init
    .then(chainEmit)
    .then(arrive(cKey(2))).then(arrive(pKey(1))).then(watch)
    .then(apply)
    .expect(and { mem.applied == [pKey(1), jKey(1), cKey(2)], safe })

  // The idle gate: nothing due, no frame.
  run noFrameWithoutInputTest =
    init
    .then(apply)
    .fail()

  // The same input arriving twice is applied once.
  run duplicateIsAppliedOnceTest =
    init
    .then(arrive(pKey(1)))
    .then(apply).then(persist).then(send)
    .then(arrive(pKey(1)))
    .then(apply)
    .fail()
}
