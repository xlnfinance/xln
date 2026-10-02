// dispute.qnt with the switches accept: FREEZE=true LIVE=true ACCEPT=true NOTICE=false
module dispute_accept {
  import dispute(FREEZE = true, LIVE = true, ACCEPT = true, NOTICE = false).* from "./dispute"
}
