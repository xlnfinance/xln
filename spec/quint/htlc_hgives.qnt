// htlc.qnt: the give-up height of PR 171 at c701bcf21 (height-gated with slack 1); see htlc_gate_test.qnt
module htlc_hgives {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 3, XREV = false, TSEE = false, BACK = false, SLK = 1, PD = 1, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false, MISSED = 0, FWD = false).* from "./htlc"
}
