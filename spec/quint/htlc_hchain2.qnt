// htlc.qnt: a chain claim cancels the slack: SLK = 2, PD = 0, HOP = 1, RSV = 2 is safe where the height gate needs HOP = 3 (hgate1)
module htlc_hchain2 {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 1, XREV = false, TSEE = false, BACK = false, SLK = 2, PD = 0, RSV = 2, CHAIN = true).* from "./htlc"
}
