/*
Here hub takes insurance from net-spenders and rebalances towards net-receivers.
Matching those with who we have promised>they_soft_limit with those where we have insured>$100

For now pretty simple. In the future can be added:
* smart learning based on balances over time not on balance at the time of matching
* use as little inputs/outputs to transfer as much as possible volume

*/

module.exports = async function () {
  if (PK.pending_tx.length > 0) return l("There are pending tx")


  var deltas = await Delta.findAll({where: {myId: me.pubkey}})

  var ins = []
  var outs = []

  me.record = await me.byKey()

  var checkBack = []



  for (var d of deltas) {
    // l("Checking channel with ", d.partnerId)

    var ch = await me.channel(d.partnerId)

    // finding who's gone beyond soft limit
    // soft limit can be raised over K.risk to pay less fees
    if (ch.promised >= Math.max(K.risk, ch.d.they_soft_limit)) {
      l('Addint output for our promise ', ch.d.partnerId)
      outs.push([ch.promised, ch.d.myId, ch.d.partnerId])

    } else if (ch.insured >= K.risk) {
      if (ch.d.input_sig) {
        l('we already have input to use')
        // method, user, hub, nonce, amount

        ins.push([ ch.d.input_amount,
          ch.d.partnerId,
          ch.d.input_sig ])
      } else if (me.users[ch.d.partnerId]) {
        l(`We can pull payment from ${toHex(ch.d.partnerId)} and use next rebalance`)
        me.send(ch.d.partnerId, 'requestWithdraw', me.envelope(ch.insured))

        checkBack.push(ch.d.partnerId)
      } else if (ch.d.withdrawal_requested_at == null) {
        l('Delayed pull')
        ch.d.withdrawal_requested_at = ts()
      } else if (ch.d.withdrawal_requested_at + 60 < ts()) {
        l('User is offline for too long, starting a dispute')
        ch.d.startDispute()
      }
    }
  }

  // checking on all inputs we expected to get, then rebalance
  setTimeout(async () => {
    for (var partnerId of checkBack) {
      var ch = await me.channel(partnerId)
      if (ch.d.input_sig) {
        ins.push([ ch.d.input_amount,
          ch.d.partnerId,
          ch.d.input_sig ])
      }
    }

    // sorting, bigger amounts are prioritized
    ins.sort((a, b) => a[0] < b[0])
    outs.sort((a, b) => a[0] < b[0])

    var finalset = [[], ins, outs]

    if (ins.length > 0 || outs.length > 0) {
      l(finalset)
      await me.broadcast('rebalance', r(finalset))
    }
  }, 3000)
}
