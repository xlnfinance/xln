// htlc.qnt: the give-up height of PR 171 at c701bcf21 (chain claim, depth 1, slack 0: LOST); see htlc_gate_test.qnt
module htlc_hgivec {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 2, RSV = 1, CHAIN = true).* from "./htlc"
}
