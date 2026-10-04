// htlc.qnt: the J loop held behind a transaction its provider fails for react + 1 blocks (R-WATCH-STALL at 2562435e3, react = 2 lag): the hub hears an event PD ticks after it landed (a height-gated claim counts views, so PD = react + 1 = 3; a chain claim counts heads and adds the depth: 4), and the hop at the floor, HOP = reserve + lag = 2, is not enough in either
module htlc_hstall {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 4, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false).* from "./htlc"
}
