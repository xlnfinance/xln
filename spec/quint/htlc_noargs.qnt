// htlc.qnt with both fixes of #162/#165 but without #167: the hub's watcher does not read the secret in a dispute's arguments
module htlc_noargs {
  import htlc(SEE = true, DISSOLVE = true, ARGS = false, HIDE = false, HOP = 2).* from "./htlc"
}
