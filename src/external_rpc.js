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

  // some socket is authenticating their pubkey 
  if (inputType == 'auth') {
    var [pubkey, sig, body] = r(msg)

    l("authing ",pubkey)

    if (ec.verify( r([methodMap('auth')]) , sig, pubkey)) {
      me.users[pubkey] = ws

      if (me.is_hub) {
        var ch = await me.channel(pubkey)
        ch.last_online = new Date()

        if (ch.input_requested_at) {
          
        }



      }

    } else {
      return false
    }


  // someone wants tx to be broadcasted
  } else if (inputType == 'tx') {
    // why would we be asked to add tx to block?
    if (!me.my_member) return false

    if (me.my_member == me.next_member) {
      l('We are next, adding to mempool :', r(msg))

      me.mempool.push(bin(msg))
    } else {
      me.send(me.next_member, 'tx', msg)
    }




  // another member wants a sig
  } else if (inputType == 'needSig') {
    var [pubkey, sig, block] = r(msg)
    var m = Members.find(f => f.block_pubkey.equals(pubkey))

    // ensure the block is non repeating
    if (m && ec.verify(block, sig, pubkey)) {
      l(`${m.id} asks us to sign their block!`)

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




  } else if (inputType == 'faucet') {
    var [result, status] = await me.payChannel({
      partner: msg,
      amount: Math.round(Math.random() * 30000),
      invoice: Buffer([0])
    })

    l(status)

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


  } else if (inputType == 'withdrawal') {
    // we received instant withdrawal for rebalance
    var [pubkey, sig, body] = r(msg)
    if (!ec.verify(body, sig, pubkey)) {
      l("Invalid withdrawal")
      return false
    }

    var ch = await me.channel(pubkey)

    var input = r([methodMap('withdrawal'), 
      ch.userId,
      ch.delta_record.hubId, 
      ch.nonce, 
      ch.insured])

    if (input.equals(body)) {
      l("Equal! save")
      ch.delta_record.our_input_amount = ch.insured
      ch.delta_record.our_input_sig = sig
      await ch.delta_record.save()
    }

  } else if (inputType == 'requestWithdraw') {
    // partner asked us for instant withdrawal 
    var [pubkey, sig, body] = r(msg)
    if (!ec.verify(body, sig, pubkey)) return false

    var ch = await me.channel(pubkey)

    var amount = readInt(r(body)[0])

    if (ch.delta_record.their_input_amount > 0) {
      l("Peer already has withdrawal from us")
      return false
    }

    if (amount == 0 || amount > ch.insurance - ch.insured) {
      l(`Peer asks for ${amount} but owns ${ch.insurance - ch.insured}`)
      return false
    }

    
    var input = me.envelope(methodMap('withdrawal'), 
      ch.userId,
      ch.delta_record.hubId, 
      ch.nonce, 
      amount)

    ch.delta_record.their_input_amount = amount
    await ch.delta_record.save()


    me.send(pubkey, 'withdrawal', input)


  } else if (inputType == 'ack') {
    var [pubkey, sig, body] = r(msg)
    var ch = await me.channel(pubkey)

    var [secret, sig]= r(body)

    if (!ec.verify(ch.delta_record.getState(), sig, pubkey)) return false

    ch.delta_record.sig = sig
    ch.delta_record.status = 'ready'

    await ch.delta_record.save()

    var invoice = toHex(sha3(secret))

    var return_to = purchases[invoice]

    if (!return_to) return false

    // ws from browser
    if (typeof return_to == 'function') {
      return_to({confirm: 'Payment succeeded', secret: toHex(secret)}) 
    } else {
      var return_ch = await me.channel(return_to)
      me.send(return_to, 'ack', me.envelope(
        secret, ec(return_ch.delta_record.getState(), me.id.secretKey)
      ))
    }


  } else if (inputType == 'update') {
    var [pubkey, sig, body] = r(msg)
    var ch = await me.channel(pubkey)

    if (ec.verify(body, sig, pubkey)) {
      var [method, transitions, stateSig, newState] = r(body)

      if (readInt(method) != methodMap('update')) {
        l("Invalid update input")
        return false
      }


      var [action, amount, mediate_to, invoice] = transitions[0]

      if (readInt(action) != methodMap('unlockedPayment')) {
        return false
      }
      amount = readInt(amount)

      if (amount < 99) {
        l("Too low amount")
        return false
      }

      if (amount > ch.receivable) {
        l("Channel is depleted") 
        return false
      }

      if (ch.delta_record.status != 'ready') {
        l("Channel is not ready") 
        return false
      }


      ch.delta_record.delta -= me.is_hub ? amount : -amount
      ch.delta_record.nonce++

      var resultState = ch.delta_record.getState()

      if (!resultState.equals(newState)) l("State mismatch ", resultState, newState)

      if (ec.verify(resultState, stateSig, pubkey)) {
        ch.delta_record.sig = stateSig 


        //l('return ACK')

        if (me.is_hub) {
          //me.send(pubkey, 'ack', ec(ch.delta_record.getState(), me.id.secretKey))

          await ch.delta_record.save()

          await me.payChannel({
            partner: mediate_to,
            amount: afterFees(amount),
            mediate_to: null,
            return_to: pubkey,
            invoice: invoice
          })          
        } else {
          await ch.delta_record.save()

          l('looking for ', invoice)

          var paid_invoice = invoices[toHex(invoice)]

          // did we get right amount in right asset?
          if (paid_invoice && 
            amount >= afterFees(paid_invoice.amount) &&
            paid_invoice.status == 'pending') {

            l('Our invoice was paid!', paid_invoice)
            paid_invoice.status = 'paid'

    
          }else {
            l("No such invoice found. Donation?")
          }

          l("Acking back to ", pubkey)
          me.send(K.members[0], 'ack', me.envelope(
            paid_invoice ? paid_invoice.secret : 0, ec(ch.delta_record.getState(), me.id.secretKey)
          ))

          await me.addHistory(amount, 'Received', true)

          react()


        }
      }
      
    } 








  }


}
