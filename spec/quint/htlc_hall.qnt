// htlc.qnt: slack, depth and no chain claim together (SLK = 2, PD = 1, HOP = 3 < SLK + PD + LAG): the hub is out one unit; the variant the gate mutants run on
module htlc_hall {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 3, XREV = false, TSEE = false, BACK = false, SLK = 2, PD = 1, RSV = 0, CHAIN = false, RD = 0, LATE = false).* from "./htlc"
}
