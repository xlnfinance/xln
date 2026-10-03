// htlc.qnt as the code stands before the fixes of #162/#165
module htlc_today {
  import htlc(SEE = false, DISSOLVE = false, ARGS = false, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 0, RSV = 0, CHAIN = false).* from "./htlc"
}
