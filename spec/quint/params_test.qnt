// The numbers that two layers must agree on, so a change to one cannot silently break the other.
// Run with: quint test params_test.qnt --backend typescript
module params_test {
  import chain as c from "./chain"
  import entity as e from "./entity"
  import jbatch as j from "./jbatch"
  import account_core as a from "./account_core"

  // one meaning of LAG: ticks for a J transaction to be included and for a J event to be read
  // the dispute windows together (entity.DWIN) are chain's two floors
  // the honest side's whole reaction (chain.REACT) fits in the entity's own arithmetic: read within LAG, land within LAG
  // the onward hop margin of a route is what the two lags need (E3)
  pure val AGREE: bool = and {
    c::LAG == e::LAG,
    j::LAG == e::LAG,                          // a batch lands within the same LAG (J3: the urgent ops of the Entity take one LAG)
    e::DWIN == 2 * c::MIN_WINDOW,
    c::REACT == 2 * e::LAG,
    e::HOP >= c::REACT,
    e::ESC >= c::LAG,
    e::DWIN > c::REACT,
    // R-HTLC-CLOCK: the Account's clock is each party's own view of the J height. A view lags the chain by at most LAG, so two views differ by at most
    // LAG (a::DRIFT), and an expiry waits for a reserve of at least LAG so that no party's view still shows the lock live.
    a::DRIFT == c::LAG,
    a::CLOCK_RESERVE >= c::LAG
  }

  run layersAgreeOnTheNumbersTest = e::init.expect(AGREE)

  // The entity's deadline arithmetic against the real dispute game. The hub is the payee (Right) of the inbound lock, whose
  // deadline is the last tick of the clock. Peer 2 resolves the onward lock off-chain at its deadline (the inbound one minus HOP),
  // the hub learns the secret then. It must put the secret on the chain in time; the payer then starts a dispute after the
  // deadline with the clause proof. The hub is paid.
  pure val D_IN = c::MAXT
  pure val D_OUT = e::outDeadline(D_IN)
  pure val CLAUSE_PROOF: c::SignedProof =
    { ...c::mkProof(true, 1, 0, true, 0, c::NO_CLAUSE, true, true),
      clause: { on: true, payer: c::Left, amount: 1, deadline: D_IN } }
  pure val HUB: int -> c::SignedProof = c::SLOTS.mapBy(_ => c::NO_PROOF).set(1, CLAUSE_PROOF)
    .set(6, c::mkProof(true, c::FIRST_NONCE_E1, 1, true, 0, c::NO_CLAUSE, true, true))

  run hopMarginPaysTheHubTest =
    c::initFrom(HUB, c::Right, 1, 0, 2)
    .then((D_OUT - 1).reps(_ => c::tick))
    .then(c::learn(c::Right))
    .then(c::publish(c::Right))                                      // lands within LAG of learning it, before D_IN
    .then((D_IN - D_OUT + 1).reps(_ => c::tick))                        // the clock runs past the deadline
    .then(c::startWith(c::Left, 1, false, 0, false))                 // a late start is fine (E6)
    .then(c::finalizeWith(c::Right, 0, 0, false))
    .expect(and { c::money.res == Map(c::Left -> 0, c::Right -> 3), c::money.debt == Map(c::Left -> 0, c::Right -> 0), c::safe })

  // Without the margin (the onward deadline equal to the inbound one) the hub learns the secret at the inbound deadline: its
  // publish needs LAG more ticks, lands after the deadline, and the payer keeps its money although peer 2 was paid.
  run noMarginLosesTheHubTest =
    c::initFrom(HUB, c::Right, 1, 0, 2)
    .then((D_IN - 1).reps(_ => c::tick))
    .then(c::learn(c::Right))
    .then(c::tick)                                                   // LAG ticks pass before the publish can be included
    .then(c::publish(c::Right))
    .then(c::startWith(c::Left, 1, false, 0, false))
    .then(c::finalizeWith(c::Right, 0, 0, false))
    .expect(and { c::money.res == Map(c::Left -> 1, c::Right -> 2), c::safe })
}
