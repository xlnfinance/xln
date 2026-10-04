// dispute.qnt with the switches decided: FREEZE=true LIVE=true ACCEPT=false NOTICE=false PAY=0
module dispute_decided {
  import dispute(FREEZE = true, LIVE = true, ACCEPT = false, NOTICE = false, PAY = 0, STALL = 0).* from "./dispute"
}
