// htlc.qnt: PD = 2, HOP = 3 = SLK + PD + LAG: safe
module htlc_hpoll3 {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 3, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 2, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false).* from "./htlc"
}
