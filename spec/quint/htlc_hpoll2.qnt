// htlc.qnt: the hub hears an event 2 ticks after it landed (depth and poll), HOP = 2: out one unit
module htlc_hpoll2 {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 2, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false).* from "./htlc"
}
