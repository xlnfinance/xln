// This method ensures all settled hashlocks were acked on time. If we don't get ack on time, the hashlock may expire and we lose the money, that's why we must go to blockchain asap to reveal the secret to hashlock
module.exports = async () => {
  //l('Checking who has not acked')

  var not_acked = await Delta.findAll({
    where: {
      ack_requested_at: {
        [Op.lt]: new Date() - 20000,
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
    l('Start dispute with ', d.id)

    d.status = 'disputed'

    me.batch.push(['revealSecrets', unacked_settles.map((s) => s.secret)])
    me.batch.push(['disputeWith', [await d.getDispute()]])

    await d.save()

    //await d.startDispute()
  }
}
