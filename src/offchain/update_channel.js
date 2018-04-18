// receive a transition for state channel
module.exports = async (msg) => {
  var [pubkey, sig, body] = r(msg)

  if (!ec.verify(body, sig, pubkey)) {
    return l('Wrong input')
  }

  var [method, ackSig, transitions] = r(body)

  method = methodMap(readInt(method))

  var ch = await me.getChannel(pubkey)

  if (ch.d.status == 'master') {
    if (method == 'requestMaster') {
      ch.d.status = 'listener'
      await ch.d.save()

      me.send(pubkey, 'update', me.envelope(methodMap('grantMaster')))
    } else {
      l('master accepts only requestMaster')
    }
    return false
  }

  if (ch.d.status == 'sent' && method != 'update') {
    return l('Sent only accepts updates')
  }

  if (ch.d.status == 'listener') {
    if (method == 'grantMaster') {
      ch.d.status = 'master'
      await ch.d.save()

      await me.payChannel(pubkey)
      return
    }

    if (method == 'requestMaster') {
      return l('Listeners cant grant master')
    }
  }

  if (method != 'update') {
    l('Invalid update input')
    return false
  }

  //l('New transitions arrived, lets apply them: ', transitions)

  // first, clone what they can pay and decrement
  var receivable = ch.they_payable

  var newState = await ch.d.getState()

  l('Current state WE EXPECT to be acked ', newState)

  if (!ec.verify(r(newState), ackSig, pubkey)) {
    return l('Invalid ack sig: ')
  }

  ch.d.nonce = newState[3]
  ch.d.sig = ackSig
  ch.d.offdelta = newState[4]
  ch.d.signed_state = r(newState)
  ch.d.status = 'ready'
  await ch.d.save()
  l('Saved ACK')

  // we process every transition to state, verify the sig, if valid - execute the action
  for (var t of transitions) {
    var m = methodMap(readInt(t[0]))
    // a lot of logic for add and addlock are the same
    if (m == 'ack') {
    } else if (m == 'addlock' || m == 'add') {
      var [amount, hash, exp, destination, unlocker] = t[1]

      exp = readInt(exp)
      amount = readInt(amount)

      if (amount < 0 || amount > receivable) {
        return l('Invalid transfer ', amount)
      }
      receivable -= amount

      newState[3]++ //nonce
      if (m == 'addlock') {
        // push a hashlock
        newState[ch.left ? 5 : 6].push([amount, hash, exp])
      } else {
        // modify offdelta directly
        //newState[4] += offdelta
      }

      // check new state and sig, save
      if (!ec.verify(r(newState), t[2], pubkey)) {
        l('Invalid state sig: ', newState, r(t[3]))
        break
      }
      ch.d.nonce = newState[3]
      ch.d.sig = t[2]
      ch.d.offdelta = newState[4]
      ch.d.signed_state = r(newState)
      await ch.d.save()

      var hl = await ch.d.createPayment({
        status: 'hashlock',
        is_inward: true,

        amount: amount,
        hash: hash,
        exp: exp,

        unlocker: unlocker
      })

      // pay to unlocker
      if (destination.equals(me.pubkey)) {
        unlocker = r(unlocker)
        var unlocked = nacl.box.open(
          unlocker[0],
          unlocker[1],
          unlocker[2],
          me.box.secretKey
        )
        if (unlocked == null) {
          return l('Bad unlocker')
        }

        l('Arrived unlocked!')

        var [box_amount, box_secret, box_invoice] = r(bin(unlocked))
        box_amount = readInt(box_amount)

        var paid_invoice = invoices[toHex(box_invoice)]

        // TODO: did we get right amount in right asset?
        if (paid_invoice && amount >= box_amount - 1000) {
          //paid_invoice.status == 'pending'

          l('Our invoice was paid!', paid_invoice)
          paid_invoice.status = 'paid'
        } else {
          l('No such invoice found. Donation?')
        }

        hl.secret = box_secret
        hl.status = 'unlocking'
        await hl.save()

        await me.payChannel(pubkey)

        react()
      } else if (me.my_hub) {
        l(`Forward ${amount} to peer or other hub ${toHex(destination)}`)

        var dest_ch = await me.getChannel(destination)
        await dest_ch.d.save()

        await dest_ch.d.createPayment({
          status: 'await',
          is_inward: false,

          amount: afterFees(amount),
          hash: hash,
          exp: exp,

          unlocker: unlocker,
          destination: destination
        })
        await me.payChannel(destination)
      } else {
        l('We arent receiver and arent a hub O_O')
      }
    } else if (m == 'settlelock' || m == 'settle') {
      var secret = t[1]
      var hash = sha3(secret)

      var outwards = newState[ch.left ? 6 : 5]

      var index = outwards.findIndex((hl) => hl[1].equals(hash))
      var hl = outwards[index]
      l('Found unlockable ', hl)

      // secret was provided, apply to offdelta
      newState[4] += ch.left ? -hl[0] : hl[0]
      newState[3]++ //nonce
      outwards.splice(index, 1)

      // check new state and sig, save
      if (!ec.verify(r(newState), t[2], pubkey)) {
        l('Invalid state sig: ', newState, r(t[3]))
        break
      }
      ch.d.nonce = newState[3]
      ch.d.sig = t[2]
      ch.d.offdelta = newState[4]
      ch.d.signed_state = r(newState)
      await ch.d.save()

      var outward = (await ch.d.getPayments({
        where: {hash: hash, is_inward: false},
        include: {all: true}
      }))[0]

      outward.secret = secret
      outward.status = 'unlocked'
      await outward.save()
      l('Removing unlock record')

      var inward = await Payment.findOne({
        where: {hash: hash, is_inward: true},
        include: {all: true}
      })

      if (inward) {
        l('Found an mediated inward to unlock with ', inward.deltum.partnerId)

        inward.secret = secret
        inward.status = 'unlocking'
        await inward.save()

        await me.payChannel(inward.deltum.partnerId)
      }
    } else if (m == 'faillock' || m == 'fail') {
    }
  }

  if (transitions.length > 0) {
    // Always ack if there were transitions
    await me.payChannel(pubkey, true)
  }

  /*
  // TESTNET: storing most profitable outcome for us
  var profitable = r(ch.d.most_profitable)
  if (
    (ch.left && ch.d.offdelta > readInt(profitable[0])) ||
    (!ch.left && ch.d.offdelta < readInt(profitable[0]))
  ) {
    ch.d.most_profitable = r([ch.d.offdelta, ch.d.nonce, ch.d.sig])
  }
  */

  l('The payment is accepted!')
}
