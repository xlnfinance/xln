// dispute.qnt with every dispute fix and PAY=2 (and a frame the chain finalized by is dropped, never sealed again)
module dispute_paydrop {
  import dispute(FREEZE = true, LIVE = true, ACCEPT = true, NOTICE = true, PAY = 2).* from "./dispute"
}
