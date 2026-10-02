// dispute.qnt with every dispute fix and PAY=1 (the payment path as #162 8f82733df has it: a refused frame is sealed again in the new epoch)
module dispute_pay {
  import dispute(FREEZE = true, LIVE = true, ACCEPT = true, NOTICE = true, PAY = 1).* from "./dispute"
}
