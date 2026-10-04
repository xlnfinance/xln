// htlc.qnt as #167 is built: the watcher reads a finalize's arguments from the input of a direct processBatch call, and the payee can finalize through a contract. Both fixes of #162/#165, ARGS on, HIDE on: the hub loses one unit.
module htlc_wrapped {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = true, HOP = 2, XREV = false, TSEE = false, BACK = false, SLK = 0, PD = 0, RSV = 0, CHAIN = false, RD = 0, LATE = false, LK = 0, ADM = -1, HG = false, MISSED = 0, FWD = false).* from "./htlc"
}
