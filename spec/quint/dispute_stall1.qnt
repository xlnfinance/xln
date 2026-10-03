// dispute.qnt with all the fixes and the Host holding an Account's events 1 tick (R-WATCH-STALL, #171): W = 4, LAG = 1, so a counter lands with room for one transient revert and its retry
module dispute_stall1 {
  import dispute(FREEZE = true, LIVE = true, ACCEPT = true, NOTICE = true, PAY = 0, STALL = 1).* from "./dispute"
}
