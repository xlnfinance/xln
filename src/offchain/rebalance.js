/*
Once in a few blocks hub takes insurance from net-spenders and rebalances towards net-receivers.
Matching those with who we have promised>they_soft_limit with those where we have insured>$100

For now pretty simple. In the future can be added:
* smart learning based on balances over time not on balance at the time of matching
* use as little inputs/outputs to transfer as much as possible volume

*/

module.exports = async function() {
  if (PK.pending_tx.length > 0) return l('There are pending tx')

  var deltas = await Delta.findAll({
    where: {
      myId: me.pubkey
      //status: 'ready'
    }
  })

  var reb = [
    [], // disputes
    [], // inputs/withdrawals
    [] // outputs/deposits
  ]

  me.record = await me.byKey()

  var checkBack = []

  for (var d of deltas) {
    var ch = await me.getChannel(d.partnerId)

    // finding who's gone beyond soft limit
    // soft limit can be raised over K.risk to pay less fees
    if (ch.promised >= Math.max(K.risk, ch.d.they_soft_limit)) {
      l('Addint output for our promise ', ch.d.partnerId)
      reb[2].push([ch.promised, ch.d.myId, ch.d.partnerId, 0])
    } else if (ch.insured >= K.risk) {
      if (ch.d.input_sig) {
        l('we already have input to use')
        // method, user, hub, nonce, amount

        reb[1].push([ch.d.input_amount, ch.d.partnerId, ch.d.input_sig])
      } else if (me.users[ch.d.partnerId]) {
        l(
          `We can pull payment from ${toHex(
            ch.d.partnerId
          )} and use next rebalance`
        )
        me.send(ch.d.partnerId, 'requestWithdraw', me.envelope(ch.insured))

        checkBack.push(ch.d.partnerId)
      } else if (ch.d.withdrawal_requested_at == null) {
        l('Delayed pull')
        ch.d.withdrawal_requested_at = ts()
        await ch.d.save()
      } else if (ch.d.withdrawal_requested_at + 60 < ts()) {
        l('User is offline for too long, or tried to cheat')
        reb[0].push(await ch.d.getDispute())
      }
    } else if (ch.d.status == 'cheat_dispute') {
      l('User tried to cheat')
      reb[0].push(await ch.d.getDispute())
    }
  }

  // checking on all inputs we expected to get, then rebalance
  setTimeout(async () => {
    for (var partnerId of checkBack) {
      var ch = await me.getChannel(partnerId)
      if (ch.d.input_sig) {
        reb[1].push([ch.d.input_amount, ch.d.partnerId, ch.d.input_sig])
      } else {
        ch.d.withdrawal_requested_at = ts()
        await ch.d.save()
      }
    }

    if (reb[0].length + reb[1].length + reb[2].length > 0) {
      // sorting, bigger amounts are prioritized
      reb[1].sort((a, b) => b[0] - a[0])
      reb[2].sort((a, b) => b[0] - a[0])

      // anything to broadcast?
      await me.broadcast('rebalance', r(reb))
    }
  }, 4000)
}
