// dispute.qnt with all the fixes and the Host holding an Account's events 3 ticks (R-WATCH-STALL, #171): W = 4, LAG = 1, so a counter lands iff the hold is under 3
module dispute_stall3 {
  import dispute(FREEZE = true, LIVE = true, ACCEPT = true, NOTICE = true, PAY = 0, STALL = 3).* from "./dispute"
}
