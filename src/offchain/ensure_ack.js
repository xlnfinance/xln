// This method ensures all settled hashlocks were acked on time. If we don't get ack on time, the hashlock may expire and we lose the money, that's why we must go to blockchain asap to reveal the secret to hashlock
module.exports = async () => {
  //l('Checking who has not acked')
  if (PK.pending_batch) return l('Pending batch')

  var not_acked = await Delta.findAll({
    where: {
      ack_requested_at: {
        [Op.lt]: new Date() - K.dispute_if_no_ack, // 2 minutes to ack
        [Op.ne]: null
      },
      status: {
        [Op.ne]: 'disputed'
      }
    }
  })

  for (var d of not_acked) {
    // not getting an ack on time is bad, but the worst is losing settled hashlock
    var unacked_settles = await d.getPayments({
      where: {
        type: 'settle',
        status: {
          [Op.ne]: 'acked'
        },
        is_inward: true
      },
      order: [['id', 'ASC']]
    })

    l('No ack dispute with ', d.id, new Date() - d.ack_requested_at)

    var to_reveal = []
    unacked_settles.map(async (s) => {
      // ensure they will still be revealed when resolve() happens. Extend lifetime if needed
      var unlocked = await Hashlock.findOne({where: {hash: s.hash}})
      if (
        !unlocked ||
        unlocked.delete_at < K.usable_blocks + K.dispute_delay + 5
      ) {
        to_reveal.push(s.secret)
      }
    })

    me.batch.push(['revealSecrets', to_reveal])
    me.batch.push(['disputeWith', d.asset, [await d.getDispute()]])

    d.status = 'disputed'

    await d.save()

    //await d.startDispute()
  }
}
