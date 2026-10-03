// htlc.qnt with both fixes of #162/#165 and #167 (ARGS), the variant of record for a trace-capable node
module htlc_both {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 0, RSV = 0, CHAIN = false).* from "./htlc"
}
