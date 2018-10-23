const withdraw = require('../offchain/withdraw')

module.exports = async (p) => {
  // perform a specific operation on given channel
  let d = await Delta.findById(p.id)
  let ch = await me.getChannel(d.partnerId, d.asset, d)

  if (p.op == 'withdraw') {
    if (p.amount > ch.insured) {
      react({alert: 'More than you can withdraw from insured'})
      return
    }
    await withdraw(ch, p.amount)
    if (ch.d.withdrawal_sig == null) {
      react({
        alert:
          'Failed to get withdrawal from: ' +
          ch.hub.handle +
          '. Try later or start a dispute.'
      })
      return
    }

    me.batchAdd('withdrawFrom', [
      ch.d.asset,
      [ch.d.withdrawal_amount, ch.partner, ch.d.withdrawal_sig]
    ])
    react({confirm: 'OK'})
  } else if (p.op == 'deposit') {
    me.batchAdd('depositTo', [
      ch.d.asset,
      [p.amount, me.record.id, ch.partner, 0]
    ])
    react({confirm: 'OK'})
  } else if (p.op == 'dispute') {
    me.batchAdd('disputeWith', [ch.d.asset, await deltaGetDispute(ch.d)])
    react({confirm: 'OK'})
  } else if (p.op == 'setLimits') {
    ch.d.hard_limit = p.hard_limit
    ch.d.soft_limit = p.soft_limit

    // nothing happened
    if (!ch.d.changed()) {
      return
    }

    await ch.d.save()

    l('set limits to ', ch.hub)

    me.send(
      ch.hub,
      'setLimits',
      me.envelope(
        methodMap('setLimits'),
        ch.d.asset,
        ch.d.soft_limit,
        ch.d.hard_limit
      )
    )

    react({confirm: 'OK'})
  } else if (p.op == 'requestInsurance') {
    me.send(
      ch.hub,
      'setLimits',
      me.envelope(methodMap('requestInsurance'), ch.d.asset)
    )

    ch.d.requested_insurance = true

    //react({confirm: 'Requested insurance, please wait'})
  } else if (p.op == 'testnet') {
    if (p.action == 4) {
      me.CHEAT_dontack = 1
    } else if (p.action == 5) {
      me.CHEAT_dontreveal = 1
    } else if (p.action == 6) {
      me.CHEAT_dontwithdraw = 1
    } else {
      me.testnet({
        action: 1,
        asset: ch.d.asset,
        amount: p.amount,
        partner: ch.partner
      })
    }
    react({confirm: 'OK'})
  }
  return {}
}
