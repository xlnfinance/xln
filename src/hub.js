/*
In this method we implement looking for net-spenders and matching them with net-receivers.
Eg matching those who have delta <-100 with those with delta>100

First, we calculate receivers who requested rebalance.
Based on how much they want to insure, we can find the minimum amount of spenders to ask withdrawals from

*/

module.exports = async function () {
  var channels = await me.channels()

  var ins = []
  var outs = []

  me.record = await me.byKey()

  var solvency = me.record.balance
  var uninsured = 0
  var checkBack = []

  for (var ch of channels) {
    channels.push(ch)

    solvency -= ch.delta

    if (ch.delta > 0) {
      uninsured += ch.delta

      if (ch.delta >= K.risk) {
        outs.push([ch.delta, d.partner, hubId])
      }
    } else if (ch.delta <= -K.risk) {
      if (ch.d.our_input_sig) {
        l('we already have input to use')
        // method, user, hub, nonce, amount

        ins.push([ ch.d.our_input_amount,
          ch.userId,
          ch.d.our_input_sig ])
      } else if (me.users[d.userId]) {
        l(`We can pull payment from ${toHex(d.userId)} and use next rebalance`)
        me.send(d.userId, 'requestWithdraw', me.envelope(ch.insured))

        checkBack.push(d.userId)
      } else {
        l('Delayed pull')
      }
    }
  }

  // checking on all inputs we expected to get, then rebalance
  setTimeout(async () => {
    for (var userId of checkBack) {
      var ch = await me.channel(userId)
      if (ch.d.our_input_sig) {
        ins.push([ ch.d.our_input_amount,
          ch.userId,
          ch.d.our_input_sig ])
      }
    }

    if (ins.length > 0 || outs.length > 0) {
      await me.broadcast('rebalanceHub', r([0, ins, outs]))
    }
  }, 5000)

  return {
    channels: channels,
    solvency: solvency
  }
}
