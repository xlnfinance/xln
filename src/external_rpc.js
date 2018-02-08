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
  // we provide block sig back
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




  } else if (inputType == 'faucet') {
    await me.payChannel({
      counterparty: msg,
      amount: Math.round(Math.random() * 6000),

      invoice: Buffer([0])
    })





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








  } else if (inputType == 'withdraw') {


  } else if (inputType == 'ack') {
    var [pubkey, sig, body] = r(msg)
    var ch = await me.channel(pubkey)

    var [secret, sig]= r(body)

    if (ec.verify(ch.delta_record.getState(), sig, pubkey)) {
      ch.delta_record.sig = sig
      ch.delta_record.status = 'ready'

      await ch.delta_record.save()

      var invoice = toHex(sha3(secret))

      var return_to = purchases[invoice]

      if (!return_to) return false


      if (return_to.send) {
        react({confirm: 'Secret received: '+toHex(secret)+' for invoice '+invoice}) 
      } else {
        var return_ch = await me.channel(return_to)
        me.send(return_to, 'ack', me.envelope(
          secret, ec(return_ch.delta_record.getState(), me.id.secretKey)
        ))
      }

    } else {
      l("Invalid ACK!")
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




      for (var act of transitions) {
        if (methodMap(act[0]) == 'unlockedPayment') {

        }

        if (methodMap(act[0]) == 'ack') {
          if (ec.verify(act[1], ch.delta_record.getState())) {
            ch.delta_record.sig = act[1]
            ch.delta_record.status = 'ready'
            await ch.delta_record.save()

            l("ACKed")
            return false
          }

        }
      }



      var [action, amount, mediate_to, invoice] = transitions[0]

      assert(readInt(action) == methodMap('unlockedPayment'))
      amount = readInt(amount)


      // channel boundaries
      assert(amount > 100, `Got ${amount} is limited by insurance ${ch.total}`)
      assert(amount <= (me.is_hub ? ch.total : ch.receivable), "Channel is depleted") 

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

          var fee = Math.round(amount * K.hub_fee)
          if (fee == 0) fee = K.hub_fee_base

          await me.payChannel({
            counterparty: mediate_to,
            amount: amount - fee,
            mediate_to: null,
            return_to: pubkey,
            invoice: invoice
          })          
        } else {
          await ch.delta_record.save()

          l('looking for ', invoice)

          var paid_invoice = invoices[toHex(invoice)]
          if (paid_invoice) {
            l('Paid invoice!', paid_invoice)
            paid_invoice.status = 'paid'


            me.send(pubkey, 'ack', me.envelope(
              paid_invoice.secret, ec(ch.delta_record.getState(), me.id.secretKey)
            ))
    
          }else {
            l("No such invoice found. Donation?")
          }

          await me.addHistory(amount, 'Received', true)

          react()


        }
      }
      
    } 








  }


}
