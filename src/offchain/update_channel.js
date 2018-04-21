// receive a transition for state channel
module.exports = async (msg) => {
  var [pubkey, sig, body] = r(msg)

  if (!ec.verify(body, sig, pubkey)) {
    return l('Wrong input')
  }

  var [method, ackSig, transitions, debugState] = r(body)

  method = methodMap(readInt(method))

  var ch = await me.getChannel(pubkey)

  if (ch.d.status == 'master') {
    if (method == 'requestMaster') {
      ch.d.status = 'listener'
      await ch.d.save()

      me.send(pubkey, 'update', me.envelope(methodMap('grantMaster')))
      return false
    } else {
      l('master doesnt expect updates')
    }
  }

  if (ch.d.status == 'sent' && method != 'update') {
    return l('Sent only accepts updates ' + method)
  }

  if (ch.d.status == 'listener') {
    if (method == 'grantMaster') {
      ch.d.status = 'master'
      await ch.d.save()

      l('we were granted master! Flushing with force')

      await me.payChannel(pubkey, true)
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

  // an array of partners we need to ack or flush changes at the end of processing
  var flushable = []

  // this is state we are on right now.
  var newState = await ch.d.getState()

  var rollback = [0, 0]

  if (!ec.verify(r(newState), ackSig, pubkey)) {
    oldState = r(ch.d.signed_state)
    prettyState(debugState)
    prettyState(oldState)

    l('Ack mismatch. States (current, theirs, our old):')

    logstate(newState)
    logstate(debugState)
    logstate(oldState)

    /*
    We received an acksig that doesnt match our current state. Apparently the partner sent
    transitions simultaneously. 

    Our job is to rollback to last known signed state, check ackSig against it, if true - apply
    partner's transitions, and then reapply the difference we made with OUR transitions
    namely - nonce and offdelta diffs because hashlocks are already processed. 
    
    We hope the partner does the same with our transitions so we both end up on equal states.

    */

    if (!ec.verify(r(oldState), ackSig, pubkey)) {
      return l('Acksig is not for old nor new state. DEAD LOCK')
    } else {
      l('Conflict resolved - rolled back to old state')

      rollback = [newState[3] - oldState[3], newState[4] - oldState[4]]
      newState = oldState
    }
  }

  ch.d.nonce = newState[3]
  ch.d.sig = ackSig
  ch.d.offdelta = newState[4]
  ch.d.signed_state = r(newState)
  ch.d.status = ch.left ? 'master' : 'listener'
  ch.d.pending = null
  await ch.d.save()
  //l('Saved ACK and became ' + ch.d.status)

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

        var [box_amount, box_secret, box_invoice] = r(bin(unlocked))
        box_amount = readInt(box_amount)

        var paid_invoice = invoices[toHex(box_invoice)]

        // TODO: did we get right amount in right asset?
        if (paid_invoice && amount >= box_amount) {
          //paid_invoice.status == 'pending'

          l('Our invoice was paid!', paid_invoice)
          paid_invoice.status = 'paid'
        } else {
          l('No such invoice found. Donation?')
        }

        hl.secret = box_secret
        hl.status = 'unlocking'
        await hl.save()

        // no need to add to flushable - secret will be returned during ack to sender anyway
      } else if (me.my_hub) {
        l(`Forward ${amount} to peer or other hub ${toHex(destination)}`)

        var dest_ch = await me.getChannel(destination)
        await dest_ch.d.save()

        await dest_ch.d.createPayment({
          status: 'await',
          is_inward: false,

          amount: afterFees(amount, me.my_hub.fee),
          hash: hash,
          exp: exp,

          unlocker: unlocker,
          destination: destination
        })

        if (flushable.indexOf(destination) == -1) flushable.push(destination)
      } else {
        l('We arent receiver and arent a hub O_O')
      }
    } else if (m == 'settlelock' || m == 'settle') {
      var secret = t[1]
      var hash = sha3(secret)

      var outwards = newState[ch.left ? 6 : 5]

      var index = outwards.findIndex((hl) => hl[1].equals(hash))
      var hl = outwards[index]

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

      var inward = await Payment.findOne({
        where: {hash: hash, is_inward: true},
        include: {all: true}
      })

      if (inward) {
        //l('Found an mediated inward to unlock with ', inward.deltum.partnerId)

        inward.secret = secret
        inward.status = 'unlocking'
        await inward.save()

        var pull_from = inward.deltum.partnerId

        if (flushable.indexOf(pull_from) == -1) flushable.push(pull_from)
      }

      if (me.handicap_dontsettle) {
        return l(
          'HANDICAP ON: not settling on a given secret, but pulling from inward'
        )
      }
    } else if (m == 'faillock' || m == 'fail') {
    }
  }

  // since we applied partner's diffs, all we need is to add the diff of our own transitions
  if (rollback[0] > 0) l('Rolling back our own diffs ', rollback)
  ch.d.nonce += rollback[0]
  ch.d.offdelta += rollback[1]
  await ch.d.save()

  // Always ack if there were transitions
  //l('Flushable: ', flushable)

  await me.payChannel(pubkey, transitions.length > 0)

  for (var fl of flushable) {
    // force flush ACK only to sender & if received any transitions
    if (!fl.equals(pubkey)) await me.payChannel(fl, true)
  }

  react()

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
}
