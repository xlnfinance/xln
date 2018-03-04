/*
In this method we implement looking for net-spenders and matching them with net-receivers.
Eg matching those who have delta <-100 with those with delta>100

First, we calculate receivers who requested rebalance.
Based on how much they want to insure, we can find the minimum amount of spenders to ask withdrawals from

*/

module.exports = async function () {

  var deltas = await Delta.findAll({where: {myId: me.pubkey}})

  var ins = []
  var outs = []

  me.record = await me.byKey()

  var checkBack = []

  var collectedSoFar = me.record.balance

  for (var d of deltas) {
    l("Checking channel with ", d.partnerId)

    var ch = await me.channel(d.partnerId)

    // finding who's gone beyond soft limit
    // soft limit can be raised over K.risk to pay less fees
    if (ch.promised >= Math.max(K.risk, ch.d.they_soft_limit)) {
      l("Covering our promise ", ch.d.partnerId)
      outs.push([ch.promised, ch.d.myId, ch.d.partnerId])
      
    } else if (ch.insured >= K.risk) {
      if (ch.d.our_input_sig) {
        l('we already have input to use')
        // method, user, hub, nonce, amount
        
        ins.push([ ch.d.our_input_amount,
          ch.d.partnerId,
          ch.d.our_input_sig ])
          
      } else if (me.users[ch.d.partnerId]) {
        l(`We can pull payment from ${toHex(ch.d.partnerId)} and use next rebalance`)
        me.send(ch.d.partnerId, 'requestWithdraw', me.envelope(ch.insured))

        checkBack.push(ch.d.partnerId)
      } else {
        l('Delayed pull')
      }
    }
  }

  // checking on all inputs we expected to get, then rebalance
  setTimeout(async () => {

    for (var partnerId of checkBack) {
      var ch = await me.channel(partnerId)
      if (ch.d.our_input_sig) {
        collectedSoFar += ch.d.our_input_amount

        ins.push([ ch.d.our_input_amount,
          ch.d.partnerId,
          ch.d.our_input_sig ])
      }
    }

    // sorting, bigger amounts are prioritized 
    ins.sort((a,b)=>a[0]<b[0])
    outs.sort((a,b)=>a[0]<b[0])

    var finalset = [0, ins, outs]

    l(finalset)


    if (ins.length > 0 || outs.length > 0) {
      await me.broadcast('rebalance', r(finalset))
    }
  }, 3000)

}
