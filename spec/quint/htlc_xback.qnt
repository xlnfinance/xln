// htlc.qnt as `xrev` with the backstop only: the hub never co-signs the upstream expiry for a hash the registry shows revealed by the lock's second, and claims by it: safe
module htlc_xback {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = true, TSEE = false, BACK = true, SLK = 0, PD = 0, RSV = 0, CHAIN = false, RD = 0, LATE = false).* from "./htlc"
}
