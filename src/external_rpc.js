// External RPC processes requests to our node coming from outside world.
// Also implements validator and hub functionality

module.exports = async (ws, msg) => {
  msg = bin(msg)
  // sanity checks 10mb
  if (msg.length > 10000000) {
    l(`too long input ${(msg).length}`)
    return false
  }
  
  var inputType = inputMap(msg[0])

  // how many blocks to share at once
  var sync_limit = 1000

  msg = msg.slice(1)

  if (['chain', 'sync', 'needSig', 'signed'].indexOf(inputType) == -1) l('External RPC: ' + inputType)

  // some socket is authenticating their pubkey
  if (inputType == 'auth') {
    var [pubkey, sig, body] = r(msg)

    if (ec.verify(r([methodMap('auth')]), sig, pubkey)) {
      if (pubkey.equals(me.pubkey)) return false

      if (ws.instance) {
        me.users[pubkey] = ws
      } else {
        me.users[pubkey] = new WebSocketClient()
        me.users[pubkey].instance = ws
      }

      if (me.is_hub) {
        var ch = await me.channel(pubkey)
        ch.d.last_online = new Date()
        
        // testnet: instead of cloud backups hub shares latest state
        //me.send(pubkey, 'ack', me.envelope(0, ec(ch.d.getState(), me.id.secretKey)))

        if (ch.withdrawal_requested_at) {
          me.send(pubkey, 'requestWithdraw', me.envelope(ch.insured))
        }
        await ch.d.save()
      }
    } else {
      return false
    }

  // accepts array of tx
  } else if (inputType == 'tx') {
    // why would we be asked to add tx to block?
    if (!me.my_member) return false

    if (me.my_member == me.next_member) {
      r(msg).map(tx=>{
        me.mempool.push(tx)
      })
    } else {
      me.send(me.next_member, 'tx', msg)
    }


  // another member wants a sig
  } else if (inputType == 'needSig') {
    var [pubkey, sig, block] = r(msg)
    var m = Members.find(f => f.block_pubkey.equals(pubkey))

    // ensure the block is non repeating
    if (m && ec.verify(block, sig, pubkey)) {
      // l(`${m.id} asks us to sign their block!`)

      me.send(m, 'signed', r([
        me.my_member.block_pubkey,
        ec(block, me.block_keypair.secretKey)
      ])
      )
    }
  // we provide block sig back
  } else if (inputType == 'signed') {
    var [pubkey, sig] = r(msg)

    var m = Members.find(f => f.block_pubkey.equals(pubkey))

    if (me.status != 'precommit') {
      l('Not expecting any sigs')
      return false
    }

    if (m && ec.verify(me.precommit, sig, pubkey)) {
      m.sig = sig
      // l(`Received another sig from  ${m.id}`)
    } else {
      l("this sig doesn't work for our block")
    }



  // testnet stuff
  } else if (inputType == 'testnet') {
    var pubkey = msg.slice(1)
    if (msg[0] == 1) {    
      await me.payChannel({
        partner: pubkey,
        amount: Math.round(Math.random() * 10000)
      })
    }

    if (msg[0] == 2) {    
      (await me.channel(pubkey)).d.startDispute()
    }

    if (msg[0] == 3) {    
      (await me.channel(pubkey)).d.startDispute(true)
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
      //l('Sharing blocks since ' + last.id)

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
      // l("No blocks to sync after " + msg.toString('hex'))
    }







  } else if (inputType == 'setLimits') { // other party defines credit limit to us
    var [pubkey, sig, body] = r(msg)

    var limits = r(body)

    if (!ec.verify(body, sig, pubkey) || readInt(limits[0]) != methodMap('setLimits')) {
      l('Invalid message')
      return false
    }

    var ch = await me.channel(pubkey)

    ch.d.they_soft_limit = readInt(limits[1])
    ch.d.they_hard_limit = readInt(limits[2])

    await ch.d.save()
    l('Received updated limits')
  } else if (inputType == 'withdrawal') { // other party gives withdrawal on-chain
    var [pubkey, sig, body] = r(msg)

    var ch = await me.channel(pubkey)
    var amount = readInt(r(body)[0])

    var input = r([methodMap('withdrawal'),
      ch.ins.leftId,
      ch.ins.rightId,
      ch.nonce,
      amount])

    if (!ec.verify(input, sig, pubkey)) {
      l('Invalid withdrawal')
      return false
    }

    l('Got withdrawal for ' + amount)
    ch.d.input_amount = amount
    ch.d.input_sig = sig
    await ch.d.save()
  } else if (inputType == 'requestWithdraw') { // other party wants to withdraw on-chain
    // partner asked us for instant withdrawal
    var [pubkey, sig, body] = r(msg)
    if (!ec.verify(body, sig, pubkey)) return false

    var ch = await me.channel(pubkey)

    var amount = readInt(r(body)[0])

    if (ch.d.they_input_amount > 0) {
      l('Peer already has withdrawal from us')
      return false
    }

    if (amount == 0 || amount > ch.they_insured) {
      l(`Peer asks for ${amount} but owns ${ch.they_insured}`)
      return false
    }

    var input = r([methodMap('withdrawal'),
      ch.ins.leftId,
      ch.ins.rightId,
      ch.nonce,
      amount])

    ch.d.they_input_amount = amount
    await ch.d.save()
    l('Gave withdrawal for ' + amount)

    me.send(pubkey, 'withdrawal', r([
      me.pubkey,
      ec(input, me.id.secretKey),
      r([amount])
    ]))
  } else if (inputType == 'ack') { // our payment was acknowledged
    var [pubkey, sig, body] = r(msg)
    var ch = await me.channel(pubkey)

    var [secret, stateSig] = r(body)

    if (!ec.verify(ch.d.getState(), stateSig, pubkey)) return l('Invalid state signed')

    ch.d.sig = stateSig
    ch.d.status = 'ready'

    await ch.d.save()

    if (secret.length == 0) return l('Got no secret ')

    var invoice = toHex(sha3(secret))

    var return_to = purchases[invoice]

    if (!return_to) return l('Nowhere to return to for ' + invoice, purchases)

    // ws from browser
    if (typeof return_to === 'function') {
      return_to({confirm: 'Payment succeeded!', secret: toHex(secret)})
    } else {
      var return_ch = await me.channel(return_to)
      me.send(return_to, 'ack', me.envelope(
        secret, ec(return_ch.d.getState(), me.id.secretKey)
      ))
    }

    delete(purchases[invoice])

  } else if (inputType == 'update') { // New payment arrived
    var [pubkey, sig, body] = r(msg)
    var ch = await me.channel(pubkey)

    if (ec.verify(body, sig, pubkey)) {
      var [method, transitions, stateSig, newState] = r(body)

      if (readInt(method) != methodMap('update')) {
        l('Invalid update input')
        return false
      }

      var [action, amount, mediate_hub, mediate_to, invoice] = transitions[0]

      if (readInt(action) != methodMap('unlockedPayment')) {
        return l('Wrong method')
      }

      amount = readInt(amount)
      mediate_hub = readInt(mediate_hub)

      if (amount < 99) {
        l('Too low amount')
        return false
      }

      if (amount > ch.they_payable) {
        l('Channel is depleted for ' + amount, ch)
        return false
      }

      if (ch.d.status != 'ready') {
        l('Channel is not ready: ' + ch.d.status)
        return false
      }

      ch.d.offdelta += ch.left ? amount : -amount
      ch.d.nonce++

      var resultState = ch.d.getState()

      if (!resultState.equals(newState)) {
        return l('State mismatch ', resultState, newState)
      }

      if (!ec.verify(resultState, stateSig, pubkey)) {
        return l('Invalid state sig')
      }
      ch.d.sig = stateSig

      // TESTNET: storing most profitable outcome for us
      var profitable = r(ch.d.most_profitable)
      if ((ch.left && ch.d.offdelta > readSInt(profitable[0])) ||
        (!ch.left && ch.d.offdelta < readSInt(profitable[0]))) {
        ch.d.most_profitable = r([packSInt(ch.d.offdelta), ch.d.nonce, ch.d.sig])
      }

      l('The payment is accepted!')
      await ch.d.save()

      if (me.is_hub && mediate_to.length > 1) {
        l(`Forward to peer or other hub ${mediate_to.length}`)


        me.send(pubkey, 'ack', me.envelope(0, ec(ch.d.getState(), me.id.secretKey)))


        var partner = mediate_hub == me.record.id ? mediate_to : Members.find(m => m.id == mediate_hub).pubkey

        await me.payChannel({
          partner: partner,
          amount: afterFees(amount),

          mediate_to: mediate_to,
          mediate_hub: mediate_hub,

          return_to: pubkey,
          invoice: invoice
        })
      } else if (true) {


        l('Looking for invoice ', invoice, mediate_to)

        var paid_invoice = invoices[toHex(invoice)]

        // TODO: did we get right amount in right asset?
        if (paid_invoice && amount >= paid_invoice.amount - 1000) {
          //paid_invoice.status == 'pending'

          // handicap
          //await sleep(3000)

          l('Our invoice was paid!', paid_invoice)
          paid_invoice.status = 'paid'
        } else {
          l('No such invoice found. Donation?')
        }

        l('Acking back to ', pubkey)
        me.send(pubkey, 'ack', me.envelope(
          paid_invoice ? paid_invoice.secret : 0, ec(ch.d.getState(), me.id.secretKey)
        ))

        await me.addHistory(pubkey, amount, 'Received', true)

        react()
      } else {
        l("No mediation target")
      }
    }
  }
}
