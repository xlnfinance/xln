// htlc.qnt with SEE only: the hub claims on a secret the chain shows, the hold is not dissolved
module htlc_see {
  import htlc(SEE = true, DISSOLVE = false, ARGS = false, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 0, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false, MISSED = 0, FWD = false).* from "./htlc"
}
