// dispute.qnt with the switches today: FREEZE=false LIVE=false ACCEPT=false NOTICE=false
module dispute_today {
  import dispute(FREEZE = false, LIVE = false, ACCEPT = false, NOTICE = false).* from "./dispute"
}
