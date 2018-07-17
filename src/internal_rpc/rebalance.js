module.exports = async (p) => {
  let ins = []
  let outs = []
  let asset = parseInt(p.asset)

  for (o of p.outs) {
    // split by @
    if (o.to.length > 0) {
      let to = o.to.split('@')
      let userId

      // looks like a pubkey
      if (to[0].length == 64) {
        userId = Buffer.from(to[0], 'hex')

        // maybe this pubkey is already registred?
        let u = await User.idOrKey(userId)

        if (u.id) {
          userId = u.id
        }
      } else {
        // looks like numerical ID
        userId = parseInt(to[0])

        let u = await User.idOrKey(userId)

        if (!u) {
          result.alert = 'User with short ID ' + userId + " doesn't exist."
          break
        }
      }

      if (o.amount.indexOf('.') == -1) o.amount += '.00'

      let amount = parseInt(o.amount.replace(/[^0-9]/g, ''))

      let withPartner = 0
      // @onchain or @0 mean onchain balance
      if (to[1] && to[1] != 'onchain' && to[1] != '0') {
        // find a hub by its handle or id
        let h = K.hubs.find((h) => h.handle == to[1] || h.id == to[1])
        if (h) {
          withPartner = h.id
        } else {
          react({alert: 'No such hub'})
          return
        }
      }

      if (amount > 0) {
        outs.push([
          amount,
          userId,
          withPartner,
          o.invoice ? Buffer.from(o.invoice, 'hex') : 0
        ])
      }
    }
  }

  if (p.request_amount > 0) {
    let partner = K.hubs.find((m) => m.id == p.partner)
    let ch = await me.getChannel(partner.pubkey, asset)
    if (p.request_amount > ch.insured) {
      react({alert: 'More than you can withdraw from insured'})
      return
    } else {
      react({confirm: 'Requested withdrawals...'})
    }
    me.send(
      partner,
      'requestWithdrawFrom',
      me.envelope(p.request_amount, asset)
    )

    // waiting for the response
    setTimeout(async () => {
      let ch = await me.getChannel(partner.pubkey, asset)
      if (ch.d.input_sig) {
        ins.push([ch.d.input_amount, ch.d.partnerId, ch.d.input_sig])

        me.batch.push(['withdrawFrom', asset, ins])
        me.batch.push(['depositTo', asset, outs])
        react({confirm: 'Onchain rebalance tx added to queue'})
      } else {
        react({
          alert: 'Failed to obtain withdrawal. Try later or start a dispute.'
        })
      }
    }, 3000)
  } else if (outs.length > 0) {
    // no withdrawals
    me.batch.push(['depositTo', asset, outs])

    if (me.batch.length == 0) {
      react({alert: 'Nothing to send onchain'})
    } else {
      react({confirm: 'Wait for tx to be added to blockchain'})
    }
  }
}
