/*
In this method we implement looking for net-spenders and matching them with net-receivers.
Eg matching those who have rdelta <-100 with those with rdelta>100

First, we calculate receivers who requested rebalance.
Based on how much they want to insure, we can find the minimum amount of spenders to ask withdrawals from

*/

module.exports = async function () {
  var hubId = me.record.id

  var deltas = await Delta.findAll({where: {hubId: hubId}})

  var ins = []
  var outs = []

  var channels = []

  me.record = await me.byKey()

  var solvency = me.record.balance

  for (var d of deltas) {
    var ch = await me.channel(d.userId)

    solvency -= ch.rdelta

    channels.push(ch)

    if (ch.rdelta <= -K.risk) {
      if (me.users[d.userId]) {
        l(`We can pull payment from ${d.userId}`)
        me.send(d.userId, 'withdraw', me.envelope(ch.insured) )

        ins.push([ch.rdelta, d.userId, d.sig])
      } else {
        l("Delayed pull")
      }

    } else if (ch.rdelta >= K.risk) {

      outs.push([ch.rdelta, d.userId, hubId])
    } else {
      // l("This is low delta ", ch)
    }
  }

  return {
    channels: channels,
    solvency: solvency,
    ins: ins,
    outs: outs
  }
}
