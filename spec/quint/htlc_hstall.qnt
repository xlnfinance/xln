// htlc.qnt: the J loop held behind a transaction its provider fails for REACT + 1 blocks (R-WATCH-CALLDATA, 2562435e3): with depth 1, lag 1 the hub hears an event 4 ticks after it landed, and the hop at the floor, HOP = reserve + lag = 2, is not enough
module htlc_hstall {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 4, RSV = 0, CHAIN = false).* from "./htlc"
}
