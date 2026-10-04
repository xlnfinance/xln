// htlc.qnt as `xrev` with the hub also reading the transformer's SecretRevealed at depth: safe
module htlc_xwatch {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = true, TSEE = true, BACK = false, SLK = 0, PD = 0, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false, MISSED = 0, FWD = false).* from "./htlc"
}
