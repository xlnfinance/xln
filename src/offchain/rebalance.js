/*
The most important job of the hub is to rebalance assets once in a while. 
1. the hub finds who wants to insure their uninsured balances. They can learn automatically (given soft limit) or manually (Request Insurance in the wallet)
2. now the hub tries to find the total amount of insurance needed from the net-spenders who are currently online
3. it's up to the alg implementation to start disputes with net-spenders who are offline for too long
4. if hub fails to find enough net-spenders right now, they may drop some low value or high value net-receivers to match the numbers on both sides
5. packs withdrawals and deposits into one large rebalance batch and broadcasts onchain

Current implementation is super simple and straightforward. There's huge room for improvement:
* smart learning based on balances over time not on balance at the time of matching
* use as little inputs/outputs to transfer as much as possible volume
* have different schedule for different assets, e.g. rebalance FRD every 1 block but rare assets every 1k blocks

General recommendations:
1. assets stuck in a dispute is a waste. It's better to do everything by mutual agreement as much as possible, w/o suffering dispute delays and locked up liquidity
2. the hub must store as little funds on their @onchain balances as possible. So once hub withdraw from net-spenders they should immediately deposit it to net-receiver.

*/

module.exports = async function(asset = 1) {
  // tries to rebalance this particular asset

  if (PK.pending_batch) return l('There are pending tx')

  var deltas = await Delta.findAll({
    where: {
      myId: me.pubkey,
      asset: asset
    }
  })

  // we request withdrawals and check in few seconds for them
  let netSpenders = []
  let netReceivers = []

  // how much we own of this asset
  let solvency = me.record.asset(asset)

  for (let d of deltas) {
    let ch = await d.getChannel()

    // finding who's gone beyond soft limit or manually requested
    // soft limit can be raised over K.risk to pay less fees
    if (
      ch.requested_insurance ||
      ch.they_uninsured >= Math.max(K.risk, ch.d.they_soft_limit)
    ) {
      //l('Adding output for our promise ', ch.d.partnerId)
      netReceivers.push([ch.they_uninsured, ch.d.partnerId])
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

        netSpenders.push(ch.d.partnerId)
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
    for (var partnerId of netSpenders) {
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
