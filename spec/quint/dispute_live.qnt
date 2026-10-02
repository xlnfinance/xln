// dispute.qnt with the switches live: FREEZE=false LIVE=true ACCEPT=false NOTICE=false
module dispute_live {
  import dispute(FREEZE = false, LIVE = true, ACCEPT = false, NOTICE = false).* from "./dispute"
}
