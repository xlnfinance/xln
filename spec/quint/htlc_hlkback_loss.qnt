// The backstop-only late lock, as one trace. A secret shown in the dispute before the hub's entry exists is dropped.
// The chain pays the clause from those arguments. The registry never sees a reveal, so the backstop has nothing to claim,
// and the upstream lock expires. `quint run --init initLoss --step stepLoss --invariant route_safe` records the violation.
module htlc_hlkback_loss {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 3, XREV = true, TSEE = true, BACK = true,
              SLK = 0, PD = 1, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 3, ADM = -1, HG = false, MISSED = 0, FWD = false).* from "./htlc"

  action goto(t: int): bool = st' = { ...st, now: if (st.now > t) st.now else t }

  action initLoss: bool =
    init
      .then(askStartWith(Payee, true)).then(landStart(Payee))
      .then(goto(2)).then(hear(Hub)).then(hear(Payee))
      .then(goto(finTime(st.disp))).then(landFinal)
      .then(goto(TUX + PD + 1))

  action stepLoss: bool = expireU
}
