// htlc.qnt: the finalize and its calldata read (watch-wait design, PR 171): in order, read 1, hop 2: lost; see htlc_gate_test.qnt
module htlc_hordlate {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 1, RSV = 0, CHAIN = false, RD = 1, LATE = false, LK = 0, ADM = -1, HG = false).* from "./htlc"
}
