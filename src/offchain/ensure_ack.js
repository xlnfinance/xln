// This method ensures all settled hashlocks were acked on time. If we don't get ack on time, the hashlock may expire and we lose the money, that's why we must go to blockchain asap to reveal the secret to hashlock
module.exports = async () => {
  //l('Checking who has not acked')

  var not_acked = await Delta.findAll({
    where: {
      ack_requested_at: {
        [Op.lt]: new Date() - 120000,
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
      }
    })
    l('No ack dispute with ', d.id, new Date() - d.ack_requested_at)
    continue

    var to_reveal = []
    unacked_settles.map(async (s) => {
      // todo ensure they will still be revealed when resolve() happens
      var unlocked = await Hashlock.findOne({where: {hash: s.hash}})
      if (!unlocked) to_reveal.push(s.secret)
    })

    me.batch.push(['revealSecrets', to_reveal])
    me.batch.push(['disputeWith', [await d.getDispute()]])

    d.status = 'disputed'

    await d.save()

    //await d.startDispute()
  }
}
