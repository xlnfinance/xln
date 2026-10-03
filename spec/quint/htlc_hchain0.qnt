// htlc.qnt: a chain claim (counted to the lock's second), SLK = 2, PD = 1, HOP = 2, no reserve: the expiry lands before the hub hears
module htlc_hchain0 {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 2, PD = 1, RSV = 0, CHAIN = true).* from "./htlc"
}
