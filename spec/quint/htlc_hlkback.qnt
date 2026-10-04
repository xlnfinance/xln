// htlc.qnt: hlkback
module htlc_hlkback {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 3, XREV = true, TSEE = true, BACK = true, SLK = 0, PD = 1, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 3, ADM = -1, HG = false, MISSED = 0, FWD = false).* from "./htlc"
}
