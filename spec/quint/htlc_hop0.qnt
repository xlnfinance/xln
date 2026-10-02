// htlc.qnt with both fixes and no room between the two deadlines: HOP = 0 breaks E3
module htlc_hop0 {
  import htlc(SEE = true, DISSOLVE = true, ARGS = true, HIDE = false, HOP = 0).* from "./htlc"
}
