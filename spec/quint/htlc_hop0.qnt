// htlc.qnt with both fixes and no room between the two deadlines: HOP = 0 breaks E3
module htlc_hop0 {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 0, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 0, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false).* from "./htlc"
}
