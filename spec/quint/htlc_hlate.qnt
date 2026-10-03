// htlc.qnt: the finalize and its calldata read (watch-wait design, PR 171): told before the read: lost at any hop; see htlc_gate_test.qnt
module htlc_hlate {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 5, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 1, RSV = 0, CHAIN = false, RD = 1, LATE = true).* from "./htlc"
}
