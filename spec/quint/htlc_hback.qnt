// htlc.qnt: the backstop alone with a deep read (PD = 2) and slack (SLK = 1): the hub waits for its read to cover the lock's second, then claims by the registry: safe
module htlc_hback {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 2, XREV = true, TSEE = false, BACK = true, SLK = 1, PD = 2, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false).* from "./htlc"
}
