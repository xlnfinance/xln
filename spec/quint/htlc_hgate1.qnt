// htlc.qnt: the contract counts a reveal 2 ticks past the height deadline (SLK) and the hub's gate counts heights: HOP 1 is too little
module htlc_hgate1 {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 1, XREV = false, TSEE = false, BACK = false, SLK = 2, PD = 0, RSV = 0, CHAIN = false).* from "./htlc"
}
