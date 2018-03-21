module.exports = async (msg) => {
  var [pubkey, sig, body] = r(msg)
  var ch = await me.channel(pubkey)

  if (ec.verify(body, sig, pubkey)) {
    var [method, transitions, stateSig, debugState] = r(body)

    if (readInt(method) != methodMap('update')) {
      l('Invalid update input')
      return false
    }

    if (ch.d.status != 'ready') {
      l('Channel is not ready: ' + ch.d.status)
      return false
    }

    l(chalk.red("New transitions arrived, lets apply them: ", transitions))

    var receivable = ch.they_payable


    var compared = Buffer.compare(ch.d.myId, ch.d.partnerId)
    var newState = [methodMap('offdelta'),
      compared==-1?ch.d.myId:ch.d.partnerId,
      compared==-1?ch.d.partnerId:ch.d.myId,
      ch.d.nonce++,
      packSInt(ch.d.offdelta),
      (await ch.d.getTransitions({where: {status: 'hashlock'}})).map(
        t=>[packSInt(t.offdelta), t.hash, t.exp]
        ) 
    ]

    // dry run
    for (var t of transitions) {

      if (readInt(t[0]) == methodMap('addHashlock')) {
        var [a, offdelta, hash, exp, unlocker] = t

        offdelta = readSInt(offdelta)
        var amount = ch.left ? offdelta : -offdelta
        if (amount < 0 || amount > receivable) {
          return l("Invalid transfer ", amount)
        }
        receivable -= amount

        newState[5].push([packSInt(offdelta), hash, exp])

      } else if (readInt(t[0]) == methodMap('unlockHashlock')) {

      }

    }


    if (!newState.equals(debugState)) {
      l(chalk.red("We expected ", debugState))

      return l('State mismatch ', debugState, newState)
    }

    if (!ec.verify(newState, stateSig, pubkey)) {
      return l('Invalid state sig')
    }

    ch.d.sig = stateSig

    if (me.is_hub) {
      me.send(pubkey, 'ack', me.envelope(0, ec(newState, me.id.secretKey)))
    }

    // all transitions were valid

    for (var t of transitions) {

      if (readInt(t[0]) == methodMap('addHashlock')) {
        var [a, offdelta, hash, exp, unlocker] = t

        offdelta = readSInt(offdelta)
        var amount = ch.left ? offdelta : -offdelta

        // pay to unlocker
        if (me.is_hub && unlocker.length > 1) {
          l(`Forward to peer or other hub ${unlocker.length}`)

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

          l('Acking back to ', pubkey)
          me.send(pubkey, 'ack', me.envelope(
            paid_invoice ? paid_invoice.secret : 0, ec(ch.d.getState(), me.id.secretKey)
          ))

          await me.addHistory(pubkey, amount, 'Received', true)

          react()
        }





      } else if (readInt(t[0]) == methodMap('unlockHashlock')) {

      }

    }





    // TESTNET: storing most profitable outcome for us
    var profitable = r(ch.d.most_profitable)
    if ((ch.left && ch.d.offdelta > readSInt(profitable[0])) ||
      (!ch.left && ch.d.offdelta < readSInt(profitable[0]))) {
      ch.d.most_profitable = r([packSInt(ch.d.offdelta), ch.d.nonce, ch.d.sig])
    }

    l('The payment is accepted!')
    await ch.d.save()
    

  }
}