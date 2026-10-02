// htlc.qnt with the switches SEE=true DISSOLVE=true HOP=2
module htlc_both {
  import htlc(SEE = true, DISSOLVE = true, HOP = 2).* from "./htlc"
}
