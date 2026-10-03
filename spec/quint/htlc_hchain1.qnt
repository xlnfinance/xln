// htlc.qnt: as hchain0 with RSV = 1 = SLK + PD - HOP: safe
module htlc_hchain1 {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 2, PD = 1, RSV = 1, CHAIN = true, RD = 0, LATE = false).* from "./htlc"
}
