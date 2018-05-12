/*
Once in a few blocks hub takes insurance from net-spenders and rebalances towards net-receivers.
Matching those with who we have promised>they_soft_limit with those where we have insured>$100

For now pretty simple. In the future can be added:
* smart learning based on balances over time not on balance at the time of matching
* use as little inputs/outputs to transfer as much as possible volume

*/

module.exports = async function() {
  if (PK.pending_batch) return l('There are pending tx')

  var deltas = await Delta.findAll({
    where: {
      myId: me.pubkey
    }
  })

  var disputes = []
  var withdrawals = []
  var outputs = []

  me.record = await me.byKey()

  var checkBack = []

  for (var d of deltas) {
    var asset = d.asset

    var ch = await me.getChannel(d.partnerId, asset)

    // finding who's gone beyond soft limit
    // soft limit can be raised over K.risk to pay less fees
    if (ch.promised >= Math.max(K.risk, ch.d.they_soft_limit)) {
      //l('Adding output for our promise ', ch.d.partnerId)
      me.batch.push([
        'depositTo',
        asset,
        [[ch.promised, ch.d.myId, ch.d.partnerId, 0]]
      ])
    } else if (ch.insured >= K.risk) {
      if (ch.d.input_sig) {
        //l('We already have input to use')
        // method, user, hub, nonce, amount

        me.batch.push([
          'withdrawFrom',
          asset,
          [[ch.d.input_amount, ch.d.partnerId, ch.d.input_sig]]
        ])
      } else if (me.users[ch.d.partnerId]) {
        // they either get added in this rebalance or next one

        me.send(
          ch.d.partnerId,
          'requestWithdrawFrom',
          me.envelope(ch.insured, asset)
        )

        checkBack.push(ch.d.partnerId)
      } else if (ch.d.withdrawal_requested_at == null) {
        l('Delayed pull')
        ch.d.withdrawal_requested_at = ts()
        await ch.d.save()
      } else if (ch.d.withdrawal_requested_at + 600 < ts()) {
        l('User is offline for too long, or tried to cheat')
        me.batch.push(['disputeWith', asset, [await ch.d.getDispute()]])
      }
    }
  }

  // checking on all inputs we expected to get, then rebalance
  setTimeout(async () => {
    for (var [partnerId, asset] of checkBack) {
      var ch = await me.getChannel(partnerId, asset)
      if (ch.d.input_sig) {
        me.batch.push([
          'withdrawFrom',
          asset,
          [[ch.d.input_amount, ch.d.partnerId, ch.d.input_sig]]
        ])
      } else {
        ch.d.withdrawal_requested_at = ts()
        await ch.d.save()
      }
    }

    // broadcast will be automatic
    // await me.broadcast()
  }, 5000)
}
