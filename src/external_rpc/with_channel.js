module.exports = async (ws, args) => {
  //todo: ensure no conflicts happen if two parties withdraw from each other at the same time
  let [pubkey, sig, body] = args
  if (!ec.verify(body, sig, pubkey)) {
    l('Invalid message in with_channel')
    return false
  }
  let json = parse(body.toString())

  await section(['use', pubkey], async () => {
    let ch = await Channel.get(pubkey)

    if (json.method == 'setLimits') {
      let subch = ch.d.subchannels.by('asset', json.asset)

      subch.they_soft_limit = json.hard_limit
      subch.they_hard_limit = json.soft_limit
      me.textMessage(ch.d.partnerId, 'Updated credit limits')
    } else if (json.method == 'requestInsurance') {
      let subch = ch.d.subchannels.by('asset', json.asset)
      subch.they_requested_insurance = true
      me.textMessage(ch.d.partnerId, 'Added to rebalance queue')
    } else if (json.method == 'giveWithdrawal') {
      let asset = parseInt(json.asset)
      let amount = parseInt(json.amount)
      let withdrawal_sig = fromHex(json.withdrawal_sig)

      let subch = ch.d.subchannels.by('asset', asset)

      let withdrawal = [
        methodMap('withdrawFrom'),
        ch.ins.leftId,
        ch.ins.rightId,
        ch.ins.withdrawal_nonce,
        amount,
        asset
      ]

      if (!ec.verify(r(withdrawal), withdrawal_sig, pubkey)) {
        l('Invalid withdrawal given', withdrawal)
        return false
      }

      l('Got withdrawal for ' + amount)
      subch.withdrawal_amount = amount
      subch.withdrawal_sig = withdrawal_sig

      if (me.withdrawalRequests[subch.id]) {
        me.withdrawalRequests[subch.id](ch)
      }

      if (argv.syncdb) ch.d.save()
    } else if (json.method == 'requestWithdrawal') {
      if (me.CHEAT_dontwithdraw) {
        // if we dont give withdrawal or are offline for too long, the partner starts dispute
        return l('CHEAT_dontwithdraw')
      }

      let subch = ch.d.subchannels.by('asset', json.asset)
      let amount = parseInt(json.amount)
      let asset = parseInt(json.asset)

      if (amount == 0 || amount > ch.derived[asset].they_insured) {
        l(
          `Partner asks for ${amount} but owns ${
            ch.derived[asset].they_insured
          }`
        )
        return false
      }

      if (amount > subch.they_withdrawal_amount) {
        // only keep the highest amount we signed on
        subch.they_withdrawal_amount = amount
      }

      let withdrawal = r([
        methodMap('withdrawFrom'),
        ch.ins.leftId,
        ch.ins.rightId,
        ch.ins.withdrawal_nonce,
        amount,
        asset
      ])
      me.sendJSON(pubkey, 'giveWithdrawal', {
        withdrawal_sig: ec(withdrawal, me.id.secretKey),
        amount: amount,
        asset: asset
      })
    } else if (json.method == 'testnet') {
      if (json.action == 'faucet') {
        var friendly_invoice = [
          'You are welcome!',
          'Demo',
          "It's free money!",
          "'\"><img src=x onerror=alert('pwned')>"
        ].randomElement()

        let pay = {
          address: json.address,
          amount: json.amount,
          invoice: friendly_invoice,
          asset: json.asset
        }

        await me.payChannel(pay)
      } else if (json.action == 'onchainFaucet') {
        me.batchAdd('depositTo', [
          json.asset,
          [json.amount, fromHex(json.pubkey), 0, bin('faucet')]
        ])
      }
    }
  })

  if (json.method == 'update') {
    //l(msg.length, ' from ', trim(pubkey), toHex(sha3(msg)))

    // ackSig defines the sig of last known state between two parties.
    // then each transitions contains an action and an ackSig after action is committed
    let flushable = await section(['use', pubkey], async () => {
      //loff(`--- Start update ${trim(pubkey)} - ${transitions.length}`)
      return me.updateChannel(
        pubkey,
        fromHex(json.ackSig),
        json.transitions,
        json.debug
      )
    })

    /*
  We MUST ack if there were any transitions, otherwise if it was ack w/o transitions
  to ourselves then do an opportunistic flush (flush if any). Forced ack here would lead to recursive ack pingpong!
  Flushable are other channels that were impacted by this update
  Sometimes sender is already included in flushable, so don't flush twice
  */

    let flushed = [me.flushChannel(pubkey, json.transitions.length == 0)]

    if (flushable) {
      for (let fl of flushable) {
        // can be opportunistic also
        if (!fl.equals(pubkey)) {
          flushed.push(me.flushChannel(fl, true))
        } else {
          loff('Tried to flush twice')
        }
      }
    }
    await Promise.all(flushed)

    if (argv.syncdb) {
      //all.push(ch.d.save())

      // end-users would prefer instant save for responsive UI
      await Periodical.syncChanges()
      //Promise.all(all)
    }

    // use lazy react for external requests
    react({private: true})
  }
}
