// dispute.qnt with the switches accept: FREEZE=true LIVE=true ACCEPT=true NOTICE=false PAY=0
module dispute_accept {
  import dispute(FREEZE = true, LIVE = true, ACCEPT = true, NOTICE = false, PAY = 0, STALL = 0).* from "./dispute"
}
