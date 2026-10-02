// dispute.qnt with the switches freeze: FREEZE=true LIVE=false ACCEPT=false NOTICE=false PAY=0
module dispute_freeze {
  import dispute(FREEZE = true, LIVE = false, ACCEPT = false, NOTICE = false, PAY = 0).* from "./dispute"
}
