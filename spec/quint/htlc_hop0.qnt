// htlc.qnt with both fixes and no room between the two deadlines: HOP = 0 breaks E3
module htlc_hop0 {
  import htlc(SEE = true, DISSOLVE = true, HOP = 0).* from "./htlc"
}
