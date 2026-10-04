// htlc.qnt as `both`, and the payee can reveal by calling DeltaTransformer.revealSecret itself: the Depository emits nothing, the watcher reads Depository logs only. The hub is out one unit.
module htlc_xrev {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = true, TSEE = false, BACK = false, SLK = 0, PD = 0, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false).* from "./htlc"
}
