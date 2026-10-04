// htlc.qnt: the backstop alone (BACK) with a hop (1) shorter than the slack (2): the registry check compares the lock SECOND (TUX = TU + SLK), so the hub survives a reveal that lands past the deadline height and still counts on chain. Safe where the height gate is not
module htlc_hbackslk {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 1, XREV = true, TSEE = false, BACK = true, SLK = 2, PD = 1, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false, MISSED = 0, FWD = false).* from "./htlc"
}
