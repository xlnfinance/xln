// Scenario tests for entity.qnt: the hub's routing and escalation on exact schedules. Time starts at 1; a lock offered with
// offset 4 has deadline 5, its onward lock 3 (HOP = 2); the hub escalates from time 4 (ESC = 1) and a J transaction takes
// LAG = 1. Run with: quint test entity_test.qnt --backend typescript
module entity_test {
  import account_core.* from "./account_core"
  import entity.* from "./entity"

  // ---- routing -------------------------------------------------------------------------------------------------------

  // A lock arrives on IN with deadline 5: the hub forwards it in the same frame, two ticks earlier.
  run forwardKeepsTheMarginTest =
    init
    .then(peerLock(1, 1, 4, 1))
    .expect(and {
      st.routes.get(1).st == Fwd, st.routes.get(1).dIn == 5, st.routes.get(1).dOut == 3,
      st.links.get(OUT).inflight.length() == 1, st.links.get(IN).tip.locks.get(1).on, safe
    })
    .then(peerAck(OUT))
    .expect(and {
      st.links.get(OUT).tip.locks.get(1).on, st.links.get(OUT).tip.locks.get(1).deadline == 3,
      st.outCommitted.get(1), deadline_chain, safe
    })

  // No room for the margin: the lock is failed back in the frame that made it committed, not left to expire.
  run tooTightFailsBackAtOnceTest =
    init
    .then(peerLock(1, 1, 2, 1))
    .expect(and {
      st.routes.get(1).st == Back, st.links.get(IN).inflight == [HtlcCancel({ id: 1 })],
      st.links.get(OUT).inflight.length() == 0, no_stranded, safe
    })
    .then(peerAck(IN))
    .expect(and { not(st.links.get(IN).tip.locks.get(1).on), st.routes.get(1).st == Idle, safe })

  // The whole payment: forward, the payee resolves, the hub resolves inbound, both Accounts move.
  run happyPathTest =
    init
    .then(peerLock(1, 1, 4, 1)).then(peerAck(OUT))
    .then(peerResolve(1, 1))
    .expect(and { st.known.get(1), st.links.get(IN).inflight == [HtlcResolve({ id: 1, secret: 1 })], safe })
    .then(peerAck(IN))
    .expect(and {
      st.links.get(IN).tip.offdelta == 1, st.links.get(OUT).tip.offdelta == 1,
      not(st.links.get(IN).tip.locks.get(1).on), not(st.links.get(OUT).tip.locks.get(1).on),
      st.routes.get(1).st == Idle, safe
    })

  // ---- deadlines and disputes ----------------------------------------------------------------------------------------

  // The inbound peer never acks the resolve. At time 4 the hub starts a dispute carrying the secret: it is on the chain at 5.
  run peerNeverAcksEscalatesTest =
    init
    .then(peerLock(1, 1, 4, 1)).then(peerAck(OUT)).then(peerResolve(1, 1))
    .then(tick).then(tick).then(tick)
    .then(timer)
    .expect(and {
      st.now == 4, st.links.get(IN).frozen, st.disp.get(IN).byUs, st.chainRev.get(1) == 5,
      st.gh.escalations == 1, st.gh.needless == false, safe
    })
    .then(tick).then(tick)
    .expect(and { st.now == 6, route_safe, safe })

  // A dispute carries every known secret that opens a payee clause of the proof, not only the one that made us start.
  run secondSecretIsCarriedTest =
    init
    .then(peerLock(1, 1, 4, 1)).then(peerAck(OUT))
    .then(peerLock(2, 2, 4, 1)).then(peerAck(OUT))
    .then(peerResolve(1, 1)).then(peerResolve(2, 2))
    .then(tick).then(tick).then(tick)
    .then(timer)
    .expect(and { st.chainRev.get(1) == 5, st.chainRev.get(2) == 5, dispute_carries_all, safe })
    .then(tick).then(tick)
    .expect(and { route_safe, safe })

  // Peer 2 resolves at the last tick its lock allows. At 3 the hub learns the secret with a tick to spare and escalates at 4 (the
  // secret is on the chain at 5, the inbound deadline). At 5 the onward lock is past its deadline, the frame is refused, and
  // with no secret the hub fails the route back. Had the onward lock had the inbound deadline, a resolve at 5 would be accepted
  // and the hub could put the secret on the chain only at 6: the payment would be lost.
  run lastTickResolveIsClaimedOrRefusedTest =
    init
    .then(peerLock(1, 1, 4, 1)).then(peerAck(OUT))
    .then(tick).then(tick)
    .then(peerResolve(1, 1))                                           // now 3: the last tick of the onward lock
    .then(tick)
    .then(timer)
    .expect(and { st.now == 4, st.chainRev.get(1) == 5, route_safe })
    .then(tick).then(timer).then(tick).then(timer).then(tick)
    .expect(and { st.now == 7, route_safe, safe })
  run lastTickResolveIsRefusedTest =
    init
    .then(peerLock(1, 1, 4, 1)).then(peerAck(OUT))
    .then(tick).then(tick).then(tick).then(timer).then(tick).then(timer)   // now 5, the hooks having run at each tick
    .then(peerResolve(1, 1))
    .expect(not(st.known.get(1)))                                      // ignored: our expire is in flight (Left wins), and it is past the deadline anyway
    .then(timer)
    .then(tick).then(timer).then(tick)
    .expect(and { st.now == 7, route_safe, safe })

  // The onward lock is not failed back the moment its deadline passes: a reveal on the chain may still be on its way.
  // Peer 2 disputes OUT, reveals the secret on the chain at 2 (in time: 3), and the hub reads the event only at 4. The hub must
  // not have cancelled the inbound lock by then.
  run lateRevealCannotBeMissedTest =
    init
    .then(peerLock(1, 1, 4, 1)).then(peerAck(OUT))
    .then(peerStartsDispute(OUT))
    .then(tick)
    .then(deliver(1))
    .then(peerReveal(1))
    .then(tick).then(tick)
    .then(timer)                                                       // now 4: the reveal is unread
    .expect(and { st.now == 4, st.routes.get(1).st == Fwd, st.links.get(IN).inflight.length() == 0 })
    .then(deliver(1))                                                  // the freed slot holds the reveal
    .expect(and { st.known.get(1), st.links.get(IN).frozen, route_safe })
    .then(tick).then(tick)
    .expect(and { st.now == 6, route_safe, safe })

  // ---- the order of the phases ---------------------------------------------------------------------------------------

  // At time 4 the peer's ack arrives and commits our resolve: the escalation in the same frame sees the lock gone.
  run arrivalsBeforeHooksTest =
    init
    .then(peerLock(1, 1, 4, 1)).then(peerAck(OUT)).then(peerResolve(1, 1))
    .then(tick).then(tick).then(tick)
    .then(peerAck(IN))
    .expect(and { not(st.links.get(IN).frozen), st.gh.escalations == 0, st.links.get(IN).tip.offdelta == 1, not(st.links.get(IN).tip.locks.get(1).on), no_needless_dispute, safe })

  // ---- a dispute on a link -------------------------------------------------------------------------------------------

  // Peer 1 starts a dispute. The hub freezes IN (frames in flight and queued are dropped), answers with its tip and puts the
  // secrets it knows on the chain.
  run peerDisputeFreezesAndIsAnsweredTest =
    init
    .then(peerLock(1, 1, 4, 1)).then(peerAck(OUT))
    .then(peerLock(2, 2, 4, 1)).then(peerAck(OUT))
    .then(peerResolve(1, 1)).then(peerResolve(2, 2))                    // IN: resolve 1 in flight, resolve 2 queued
    .then(peerStartsDispute(IN))
    .then(tick)
    .then(deliver(1))
    .expect(and {
      st.links.get(IN).frozen, st.disp.get(IN).answered, st.links.get(IN).inflight.length() == 0,
      st.links.get(IN).mempool.length() == 0, st.chainRev.get(1) != 0, st.chainRev.get(2) != 0,
      no_frame_on_frozen, dispute_carries_all, safe
    })

  // ---- commands ------------------------------------------------------------------------------------------------------

  // The second payment has no room: the command changes nothing and keeps its nonce. The corrected one applies.
  run commandIsAllOrNothingTest =
    init
    .then(cmd(1, [{ link: OUT, tx: Pay({ from: Left, amount: 2 }) }, { link: OUT, tx: Pay({ from: Left, amount: 1 }) }]))
    .expect(and {
      st.nextCmd == 1, st.links.get(OUT).inflight.length() == 0, st.links.get(OUT).mempool.length() == 0, cmd_atomic, safe
    })
    .then(cmd(1, [{ link: OUT, tx: Pay({ from: Left, amount: 1 }) }, { link: OUT, tx: Pay({ from: Left, amount: 1 }) }]))
    .expect(and { st.nextCmd == 2, st.links.get(OUT).inflight.length() == 2, cmd_atomic, safe })
    .then(cmd(1, [{ link: OUT, tx: Pay({ from: Left, amount: 1 }) }]))
    .expect(and { st.nextCmd == 2, st.gh.cmds == 1 })                     // a replayed nonce is refused

  // ---- peers cannot stop the Entity ----------------------------------------------------------------------------------

  run refusalNeverHaltsTest =
    init
    .then(feed(Arrive({ link: OUT, tx: HtlcResolve({ id: 1, secret: 1 }) })))
    .expect(and { st.gh.refusals == 1, no_peer_halt, st.links.get(OUT).tip == START_TIP })
    .then(feed(Arrive({ link: IN, tx: Pay({ from: Left, amount: 3 }) })))
    .expect(and { st.gh.refusals == 2, no_peer_halt })

  // ---- collisions (account rule R-A1 as the Entity lives it) ---------------------------------------------------------

  // We are Right on IN: our frame in flight (the cancel) goes back to the queue and the peer's frame is applied first.
  run rightRollsBackOnCollisionTest =
    init
    .then(peerLock(1, 1, 2, 1))                                        // fails back: IN inflight = [Cancel 1]
    .then(peerLock(2, 2, 4, 1))                                        // peer 1's frame collides with it
    .expect(and {
      st.gh.collisions == 1, st.links.get(IN).tip.locks.get(2).on,
      st.links.get(IN).inflight.length() >= 1, st.links.get(IN).inflight.foldl(false, (a, t) => a or t == HtlcCancel({ id: 1 })),
      safe
    })

  // We are Left on OUT: our frame in flight stands and the peer's is ignored.
  run leftKeepsItsFrameOnCollisionTest =
    init
    .then(peerLock(1, 1, 4, 1))                                        // OUT inflight = [Lock 1]
    .then(peerCancel(1))
    .expect(and { st.gh.collisions == 1, st.gh.refusals == 0, st.links.get(OUT).inflight.length() == 1, not(st.links.get(OUT).tip.locks.get(1).on) })

  // ---- several inputs in one frame (E1) -----------------------------------------------------------------------------

  action feedList(inps: List[Input]): bool = all { st.now <= MAXT, st' = frameOf(st, inps) }

  // The ack that resolves the inbound lock and an unrelated refused frame arrive together at the tick the hub would escalate:
  // both are applied before the hooks read, so there is no dispute, and the refusal is a value.
  run ackAndRefusalInOneFrameTest =
    init
    .then(peerLock(1, 1, 4, 1)).then(peerAck(OUT)).then(peerResolve(1, 1))
    .then(tick).then(tick).then(tick)
    .then(feedList([AckOf(IN), Arrive({ link: OUT, tx: HtlcCancel({ id: 2 }) })]))
    .expect(and {
      not(st.links.get(IN).frozen), st.gh.escalations == 0, st.links.get(IN).tip.offdelta == 1,
      st.gh.refusals == 1, no_peer_halt, no_needless_dispute, safe
    })

  // A peer's frame and a chain event in one frame, in the Runtime's order: the frame is applied first, then the dispute is read and
  // freezes the Account. The frame is part of the state the Entity answers the dispute with.
  run peerFrameBeforeChainEventTest =
    init
    .then(peerStartsDispute(IN))
    .then(tick)
    .then(feedList([Arrive({ link: IN, tx: HtlcLock({ id: 1, payer: peerSide(IN), amount: 1, hashlock: hashOf(1), deadline: 5 }) }), JDeliver(1)]))
    .expect(and {
      st.links.get(IN).frozen, st.links.get(IN).tip.locks.get(1).on, st.disp.get(IN).proof.locks.get(1).on,
      no_frame_on_frozen, no_peer_halt, safe
    })

  // The same two inputs the other way round: the Account is frozen first and the frame changes nothing. The order is the Runtime's
  // rule (runtime.qnt R1), and it is what makes the result the same on every replica.
  run chainEventBeforePeerFrameDiffersTest =
    init
    .then(peerStartsDispute(IN))
    .then(tick)
    .then(feedList([JDeliver(1), Arrive({ link: IN, tx: HtlcLock({ id: 1, payer: peerSide(IN), amount: 1, hashlock: hashOf(1), deadline: 5 }) })]))
    .expect(and { st.links.get(IN).frozen, not(st.links.get(IN).tip.locks.get(1).on), st.routes.get(1).st == Idle })
}
