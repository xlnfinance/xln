// dispute.qnt with every dispute fix and PAY=3: a node drops the payment of every frame it signed in the epoch that the chain's finalize paid by, a rolled-back frame too
module dispute_payall {
  import dispute(FREEZE = true, LIVE = true, ACCEPT = true, NOTICE = true, PAY = 3).* from "./dispute"
}
