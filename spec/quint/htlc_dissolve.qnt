// htlc.qnt with DISSOLVE only
module htlc_dissolve {
  import htlc(SEE = false, DISSOLVE = true, ARGS = false, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 0, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false, MISSED = 0, FWD = false).* from "./htlc"
}
