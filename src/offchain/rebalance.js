/*
Once in a few blocks
1. hub finds who needs to insured uninsured balances
2. requests withdrawals from net-spenders up to that amount
3. sends a batch onchain

In the future can be added:
* smart learning based on balances over time not on balance at the time of matching
* use as little inputs/outputs to transfer as much as possible volume

todo: ensure we have enoguh assets for depositTo
add conversion rates for other assets K.risk
*/

module.exports = async function() {
  if (PK.pending_batch) return l('There are pending tx')

  var deltas = await Delta.findAll({
    where: {
      myId: me.pubkey
    }
  })

  // we request withdrawals and check in few seconds for them
  var checkBack = []

  for (var d of deltas) {
    var asset = d.asset

    var ch = await d.getChannel()

    // finding who's gone beyond soft limit
    // soft limit can be raised over K.risk to pay less fees
    if (ch.they_uninsured >= Math.max(K.risk, ch.d.they_soft_limit)) {
      //l('Adding output for our promise ', ch.d.partnerId)
      me.batch.push([
        'depositTo',
        asset,
        [[ch.they_uninsured, ch.d.myId, ch.d.partnerId, 0]]
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

        checkBack.push([ch.d.partnerId, asset])
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
          ch.d.asset,
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
