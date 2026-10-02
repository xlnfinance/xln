// dispute.qnt with the switches freeze: FREEZE=true LIVE=false ACCEPT=false NOTICE=false
module dispute_freeze {
  import dispute(FREEZE = true, LIVE = false, ACCEPT = false, NOTICE = false).* from "./dispute"
}
