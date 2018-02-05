// External RPC processes requests to our node coming from outside node. 
// Also implements validator and hub functionality

module.exports = async (ws, msg) => {

  msg = bin(msg)
  // sanity checks 100mb
  if (msg.length > 100000000) {
    l(`too long input ${(msg).length}`)
    return false
  }

  var inputType = inputMap(msg[0])
  
  // how many blocks to share at once
  var sync_limit = 100

  msg = msg.slice(1)

  l('New input: ' + inputType)

  if (inputType == 'auth') {
    let obj = me.offchainVerify(msg)
    l('Someone connected: ' + toHex(obj.signer))

    me.users[obj.signer] = ws

    if (me.is_hub) {
      // offline delivery if missed
      var ch = await me.channel(obj.signer)
      if (ch.delta_record.id) {
        var body = r([
          methodMap('delta'), obj.signer, ch.delta_record.nonce, packSInt(ch.delta_record.delta), ts()
        ])

        var sig = ec(body, me.id.secretKey)
        // share last proof

        me.send(obj.signer, 'mediate', r([
          bin(me.id.publicKey), bin(sig), body, 0
        ]))
      }
    }


    return false
  } else if (inputType == 'tx') {
    // why would we be asked to add tx to block?
    if (!me.my_member) return false

    if (me.my_member == me.next_member) {
      l('We are next, adding to mempool :', r(msg))

      me.mempool.push(bin(msg))
    } else {
      me.send(me.next_member, 'tx', msg)
    }
  } else if (inputType == 'needSig') {
    var [pubkey, sig, block] = r(msg)
    var m = me.members.find(f => f.block_pubkey.equals(pubkey))

    // ensure the block is non repeating
    if (m && ec.verify(block, sig, pubkey)) {
      l(`${m.id} asks us to sign their block!`)

      me.send(m, 'signed', r([
          me.my_member.block_pubkey,
          ec(block, me.block_keypair.secretKey)
        ])
      )
    }

    // a member needs your signature
  } else if (inputType == 'faucet') {
    await me.payChannel(msg, {
      amount: Math.round(Math.random() * 6000)
    })
  } else if (inputType == 'signed') {
    var [pubkey, sig] = r(msg)

    var m = me.members.find(f => f.block_pubkey.equals(pubkey))

    assert(me.status == 'precommit', 'Not expecting any sigs')

    if (m && ec.verify(me.precommit, sig, pubkey)) {
      m.sig = sig
      // l(`Received another sig from  ${m.id}`)
    } else {
      l("this sig doesn't work for our block")
    }
  } else if (inputType == 'chain') {
    var chain = r(msg)
    for (var block of chain) {
      await me.processBlock(block)
    }
    if (chain.length == sync_limit) {
      sync()
    }
  } else if (inputType == 'sync') {
    var last = await Block.findOne({where: {
      prev_hash: msg
    }})

    if (last) {
      l('Sharing blocks since ' + last.id)

      var blocks = await Block.findAll({
        where: {
          id: {[Sequelize.Op.gte]: last.id}
        },
        limit: sync_limit
      })

      var blockmap = []

      for (var b of blocks) {
        blockmap.push(b.block)
      }

      ws.send(concat(inputMap('chain'), r(blockmap)))
    } else {
      l("No blocks to sync after " + msg.toString('hex'))
    }

  } else if (inputType == 'mediate') {
    var [pubkey, sig, body, mediate_to, invoice] = r(msg)

    if (ec.verify(body, sig, pubkey)) {
      var [counterparty, nonce, delta, instant_until] = me.parseDelta(body)

      if (me.is_hub) {
        assert(readInt(counterparty) == 1)

        var ch = await me.channel(pubkey)

        l(nonce, ch.delta_record.nonce + 1)

        assert(nonce >= ch.delta_record.nonce, `${nonce} ${ch.delta_record.nonce}`)
        ch.delta_record.nonce++
        // assert(nonce == ch.delta_record.nonce)

        l('delta ', ch.delta_record.delta, delta)

        var amount = ch.delta_record.delta - delta

        l(`Sent ${amount} out of ${ch.total}`)

        assert(amount > 0 && amount <= ch.total, `Got ${amount} is limited by insurance ${ch.total}`)

        ch.delta_record.delta = delta
        ch.delta_record.sig = r([pubkey, sig, body]) // raw delta

        await ch.delta_record.save()

        var fee = Math.round(amount * K.hub_fee)
        if (fee == 0) fee = K.hub_fee_base

        await me.payChannel(mediate_to, {
          amount: amount - fee,
          mediate_to: null, 
          invoice: invoice
        })
      } else {
        // is it for us?
        assert(counterparty.equals(bin(me.id.publicKey)))

        var hub = await User.findById(1)

        assert(hub.pubkey.equals(pubkey))

        var ch = await me.channel(1)

        l(delta, ch.delta_record.delta)

        // for users, delta of deltas is reversed
        var amount = parseInt(delta - ch.delta_record.delta)

        assert(amount > 0)

        l(`${amount} received payment of  ${delta}`)

        ch.delta_record.nonce++
        assert(nonce >= ch.delta_record.nonce)

        l(invoices)
        if (invoices[toHex(invoice)]) {
          l('Paid invoice!')
          invoices[toHex(invoice)].status = 'paid'
        }

        ch.delta_record.delta = delta
        ch.delta_record.sig = r([pubkey, sig, body]) // raw delta

        await ch.delta_record.save()


        await me.addHistory(amount, 'Received', true)

        react()
      }
    }
  }
}
