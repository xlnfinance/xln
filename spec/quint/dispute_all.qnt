// dispute.qnt with the switches all: FREEZE=true LIVE=true ACCEPT=true NOTICE=true PAY=0
module dispute_all {
  import dispute(FREEZE = true, LIVE = true, ACCEPT = true, NOTICE = true, PAY = 0, STALL = 0).* from "./dispute"
}
