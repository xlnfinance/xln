// htlc.qnt with the switches SEE=false DISSOLVE=true HOP=2
module htlc_dissolve {
  import htlc(SEE = false, DISSOLVE = true, HOP = 2).* from "./htlc"
}
