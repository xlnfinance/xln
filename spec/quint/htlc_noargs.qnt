// htlc.qnt with both fixes of #162/#165 but without #167: the hub's watcher does not read the secret in a dispute's arguments
module htlc_noargs {
  import htlc(SEE = true, DISSOLVE = true, ARGS = false, HIDE = false, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 0, RSV = 0, CHAIN = false).* from "./htlc"
}
