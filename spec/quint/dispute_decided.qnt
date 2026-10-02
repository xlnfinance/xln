// dispute.qnt with the switches decided: FREEZE=true LIVE=true ACCEPT=false NOTICE=false
module dispute_decided {
  import dispute(FREEZE = true, LIVE = true, ACCEPT = false, NOTICE = false).* from "./dispute"
}
