// dispute.qnt with the switches today: FREEZE=false LIVE=false ACCEPT=false NOTICE=false PAY=0
module dispute_today {
  import dispute(FREEZE = false, LIVE = false, ACCEPT = false, NOTICE = false, PAY = 0, STALL = 0).* from "./dispute"
}
