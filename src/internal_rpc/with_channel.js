const withdraw = require('../offchain/withdraw')

module.exports = async (p) => {
  // perform a specific operation on given channel
  let ch = await Channel.get(fromHex(p.partnerId))
  let subch = ch.d.subchannels.by('asset', p.asset)
  if (!subch) {
    l('no subch')
    return false
  }

  if (p.op == 'withdraw') {
    if (p.amount > ch.derived[p.asset].insured) {
      react({alert: 'More than you can withdraw from insured'})
      return
    }
    await withdraw(ch, subch, p.amount)
    if (subch.withdrawal_sig == null) {
      react({
        alert: 'Failed to get withdrawal. Try later or start a dispute.'
      })
      return
    }

    me.batchAdd('withdrawFrom', [
      p.asset,
      [subch.withdrawal_amount, ch.partner, subch.withdrawal_sig]
    ])
    react({confirm: 'OK'})
  } else if (p.op == 'deposit') {
    // not used
    me.batchAdd('depositTo', [p.asset, [p.amount, me.record.id, ch.partner, 0]])
    react({confirm: 'OK'})
  } else if (p.op == 'setLimits') {
    subch.hard_limit = p.hard_limit
    subch.soft_limit = p.soft_limit

    // nothing happened
    if (!subch.changed()) {
      //return
    }

    await subch.save()

    l('set limits to ', ch.d.partnerId)

    me.send(
      ch.d.partnerId,
      'setLimits',
      me.envelope(
        methodMap('setLimits'),
        subch.asset,
        subch.soft_limit,
        subch.hard_limit
      )
    )

    react({confirm: 'OK'})
  } else if (p.op == 'requestInsurance') {
    me.send(
      ch.d.partnerId,
      'setLimits',
      me.envelope(methodMap('requestInsurance'), p.asset)
    )

    subch.requested_insurance = true

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
        asset: p.asset,
        amount: p.amount,
        partner: ch.partner
      })
    }
    react({confirm: 'OK'})
  }
  return {}
}
