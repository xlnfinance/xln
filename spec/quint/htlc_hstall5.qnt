// htlc.qnt: as hstall with HOP = 5 = PD + LAG: safe
module htlc_hstall5 {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 5, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 4, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false).* from "./htlc"
}
