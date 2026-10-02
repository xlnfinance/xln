// dispute.qnt with the switches live: FREEZE=false LIVE=true ACCEPT=false NOTICE=false PAY=0
module dispute_live {
  import dispute(FREEZE = false, LIVE = true, ACCEPT = false, NOTICE = false, PAY = 0).* from "./dispute"
}
