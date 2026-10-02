// dispute.qnt with the switches all: FREEZE=true LIVE=true ACCEPT=true NOTICE=true
module dispute_all {
  import dispute(FREEZE = true, LIVE = true, ACCEPT = true, NOTICE = true).* from "./dispute"
}
