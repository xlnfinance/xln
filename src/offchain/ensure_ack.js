// This method ensures all settled hashlocks were ack on time. If we don't get ack on time, the hashlock may expire and we lose the money, that's why we must go to blockchain asap to reveal the secret to hashlock
module.exports = async () => {
  //l('Checking who has not ack')
  if (PK.pending_batch) return l('Pending batch')

  for (var key in me.cached) {
    var ch = me.cached[key]

    if (
      // already disputed
      ch.d.status == 'disputed' ||
      // not awaiting ack
      !ch.d.ack_requested_at ||
      // they still have some time
      ch.d.ack_requested_at > new Date() - K.dispute_if_no_ack
    ) {
      continue
    }

    var to_reveal = []

    // TODO: Consider not disputing with people when no funds are at risk i.e. only dispute about unacked settles.
    refresh(ch)

    // not getting an ack on time is bad, but the worst is losing settled hashlock
    for (var inward of ch.payments) {
      // we have secret for inward payment but it's not acked
      if (inward.is_inward && inward.secret && inward.status != 'ack') {
        // ensure they will still be revealed when resolve() happens. Extend lifetime if needed
        var unlocked = await Hashlock.findOne({where: {hash: inward.hash}})
        if (
          !unlocked ||
          unlocked.delete_at <
            K.usable_blocks + K.dispute_delay + K.hashlock_exp // when we expect resolution of our dispute
        ) {
          to_reveal.push(inward.secret)
        } else {
          l('Already unlocked')
        }
      }
    }

    l(
      `No ack dispute with ${trim(ch.d.partnerId)} secrets ${to_reveal.length}`,
      ch
    )

    me.batch.push(['revealSecrets', to_reveal])
    me.batch.push(['disputeWith', ch.d.asset, [await ch.d.getDispute()]])
    ch.d.status = 'disputed'
  }
}
