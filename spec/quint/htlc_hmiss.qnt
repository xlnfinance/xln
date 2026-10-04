// htlc.qnt: HOP = 2, MISSED = 1. The seconds arm of the forward gap is one short of the reaction, so both holds stay false.
module htlc_hmiss {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 2, PD = 0, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false, MISSED = 1, FWD = true).* from "./htlc"
}
