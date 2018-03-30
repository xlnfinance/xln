module.exports = async (msg) => {
  var [pubkey, sig, body] = r(msg)

  if (!ec.verify(body, sig, pubkey)) {
    return l("Wrong input")
  }


  var [method, transitions, stateSig, debugState] = r(body)

  if (readInt(method) != methodMap('update')) {
    l('Invalid update input')
    return false
  }

  var ch = await me.channel(pubkey)


  if (ch.d.status != 'ready') {
    l('Channel is not ready: ' + ch.d.status)
    return false
  }



  l("New transitions arrived, lets apply them: ", transitions)

  var receivable = ch.they_payable

  var newState = await ch.d.getState()

  // we process every transition to state, verify the sig, if valid - execute the action
  for (var t of transitions) {
    if (readInt(t[0]) == methodMap('addlock')) {
      var [offdelta, hash, exp, unlocker] = t[1]

      exp = readInt(exp)
      offdelta = readSInt(offdelta)

      var amount = ch.left ? offdelta : -offdelta
      if (amount < 0 || amount > receivable) {
        return l("Invalid transfer ", amount)
      }
      receivable -= amount

      l('We got ', amount)

      newState[3]++ //nonce
      newState[5].push([packSInt(offdelta), hash, exp])


      // check new state and sig

      if (!ec.verify(r(newState), t[2], pubkey)) {
        l('Invalid state sig: ', newState, r(t[3]))
        break
      }
      ch.d.nonce = newState[3]
      ch.d.sig = t[2]
      ch.d.signed_state = r(newState)
      await ch.d.save()

      // pay to unlocker
      if (me.is_hub && unlocker.length > 1) {
        l(`Forward to peer or other hub ${unlocker.length}`)

        var hl = await ch.d.createTransition({
          hash: hash,
          exp: exp,
          offdelta: offdelta,
          status: 'hashlock'
        })

        await me.payChannel({
          partner: unlocker,
          amount: afterFees(amount),

          return_to: pubkey,
          invoice: hash
        })
      } else {
        var paid_invoice = invoices[toHex(hash)]

        // TODO: did we get right amount in right asset?
        if (paid_invoice && amount >= paid_invoice.amount - 1000) {
          //paid_invoice.status == 'pending'

          l('Our invoice was paid!', paid_invoice)
          paid_invoice.status = 'paid'
        } else {
          l('No such invoice found. Donation?')
        }

        l('Remove hashlock in transition')

        var hl = await ch.d.createTransition({
          hash: hash,
          exp: exp,
          offdelta: offdelta,
          status: 'unlocked'
        })

        ack_transitions.push([methodMap('settle', hash, paid_invoice.secret)])


        await me.addHistory(pubkey, amount, 'Received', true)

        react()
      }


    } else if (readInt(t[0]) == methodMap('settlelock')) {
      var hash = t[1]
      var index = newState[5].findIndex(hl=>hl[1].equals(hash))
      var hl = newState[5][index]
      l("Found unlockable ", hl)

      if (hash.equals(sha3(t[2]))) {
        // secret was provided, apply to offdelta
        ch.d.offdelta += readSInt(hl[0])
        newState[5].splice(index, 1)


      } else {
        l('Wrong secret')

      }



      var hash = t[1]
      var index = newState[5].findIndex(hl=>hl[1].equals(hash))
      var hl = await ch.d.findTransition({where: {hash: hash}})

      l("Found unlockable ", hl)

      if (hash.equals(sha3(t[2]))) {
        // secret was provided, apply to offdelta
        ch.d.offdelta += hl.offdelta
        hl.status = 'archive'
        await hl.save()
      }



    }

  }


  if (me.is_hub) {
    me.send(pubkey, 'update', me.envelope(methodMap('update'), [], ec(ch.d.signed_state, me.id.secretKey)))
  }

  // all transitions were valid, now change db
  var ack_transitions = []


  me.send(pubkey, 'update', me.envelope(
    methodMap('update'), 
    ack_transitions, 
    ec(ch.d.getState(), me.id.secretKey)
  ))



  // TESTNET: storing most profitable outcome for us
  var profitable = r(ch.d.most_profitable)
  if ((ch.left && ch.d.offdelta > readSInt(profitable[0])) ||
    (!ch.left && ch.d.offdelta < readSInt(profitable[0]))) {
    ch.d.most_profitable = r([packSInt(ch.d.offdelta), ch.d.nonce, ch.d.sig])
  }

  l('The payment is accepted!')
  await ch.d.save()
  
}