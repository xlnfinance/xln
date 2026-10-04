// htlc.qnt: the give-up height of PR 171 at c701bcf21 (chain claim, depth 1, slack 1: safe); see htlc_gate_test.qnt
module htlc_hgivecs {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 1, PD = 1, RSV = 1, CHAIN = true, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false).* from "./htlc"
}
