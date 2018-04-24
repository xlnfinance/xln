// Receives an ack and set of transitions to execute on top of it by the partner
module.exports = async (msg) => {
  var [pubkey, sig, body] = r(msg)

  if (!ec.verify(body, sig, pubkey)) {
    return l('Wrong input')
  }

  // ackSig defines the sig of last known state between two parties.
  // then each transitions contains an action and an ackSig after action is committed
  // debugState/signedState are purely for debug phase
  var [method, ackSig, transitions, debugState, signedState] = r(body)

  if (methodMap(readInt(method)) != 'update') {
    l('Invalid update input')
    return false
  }

  var ch = await me.getChannel(pubkey)

  oldState = r(ch.d.signed_state)
  prettyState(oldState)

  prettyState(debugState)
  prettyState(signedState)

  // first, clone what they can pay and decrement
  var receivable = ch.they_payable

  // an array of partners we need to ack or flush changes at the end of processing
  var flushable = []

  // indexOf doesn't work with Buffers
  var uniqAdd = (add) => {
    if (!flushable.find((f) => f.equals(add))) {
      flushable.push(add)
    }
  }

  // this is state we are on right now.
  var newState = await ch.d.getState()

  var rollback = [0, 0]

  if (newState[1][2] != debugState[1][2]) {
    l(
      `# ${newState[1][2]} vs ${debugState[1][2]} vs ${oldState[1][2]}. ${
        transitions.length
      }`
    )
  }
  //l(stringify(newState))
  //l(stringify(debugState))

  if (!await ch.d.saveState(newState, ackSig)) {
    if (transitions.length == 0) return l('Empty invalid ack')

    oldState = r(ch.d.signed_state)
    prettyState(oldState)

    if (ch.d.status == 'merge') {
      return l('Rollback cant rollback')
    }

    /*

    We received an acksig that doesnt match our current state. Apparently the partner sent
    transitions simultaneously. 

    Our job is to rollback to last known signed state, check ackSig against it, if true - apply
    partner's transitions, and then reapply the difference we made with OUR transitions
    namely - nonce and offdelta diffs because hashlocks are already processed. 
    
    We hope the partner does the same with our transitions so we both end up on equal states.

    */

    if (!await ch.d.saveState(oldState, ackSig)) {
      logstate(newState)
      logstate(oldState)
      logstate(debugState)
      logstate(signedState)

      l('Dead lock! Trying to recover by sending last ack')
      await me.flushChannel(ch)

      return false
    } else {
      l('Rollback to old state')

      rollback = [
        newState[1][2] - oldState[1][2],
        newState[1][3] - oldState[1][3]
      ]
      newState = oldState
    }
  }

  var outwards = newState[ch.left ? 3 : 2]

  // we apply a transition to canonical state, if sig is valid - execute the action
  for (var t of transitions) {
    var m = methodMap(readInt(t[0]))

    if (m == 'add') {
      var [amount, hash, exp, destination, unlocker] = t[1]

      exp = readInt(exp)
      amount = readInt(amount)

      if (amount < 0 || amount > receivable) {
        return l('Invalid transfer ', amount)
      }
      receivable -= amount

      newState[1][2]++ //nonce
      // push a hashlock
      newState[ch.left ? 2 : 3].push([amount, hash, exp])

      // check new state and sig, save
      if (!await ch.d.saveState(newState, t[2])) {
        l('Invalid state sig add')
        break
      }

      var hl = await ch.d.createPayment({
        status: 'add_sent',
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
          l('Bad unlocker')
          hl.status = 'fail'
        } else {
          var [box_amount, box_secret, box_invoice] = r(bin(unlocked))
          box_amount = readInt(box_amount)

          invoices[box_invoice] = {
            amount: box_amount,
            asset: 0
          }

          //react({confirm: 'Received a payment'})
          hl.invoice = box_invoice.toString()

          hl.secret = box_secret
          hl.status = 'settle'
        }

        await hl.save()

        // no need to add to flushable - secret will be returned during ack to sender anyway
      } else if (me.my_hub) {
        l(`Forward ${amount} to peer or other hub ${toHex(destination)}`)
        var outward_amount = afterFees(amount, me.my_hub.fee)

        var dest_ch = await me.getChannel(destination)

        // is online? Is payable?

        if (dest_ch.payable >= outward_amount) {
          await dest_ch.d.save()

          await dest_ch.d.createPayment({
            status: 'add',
            is_inward: false,

            amount: outward_amount,
            hash: hash,
            exp: exp,

            unlocker: unlocker,
            destination: destination
          })

          uniqAdd(dest_ch.d.partnerId)
        } else {
          hl.status = 'fail'
          await hl.save()
        }
      } else {
        l('We arent receiver and arent a hub O_O')
      }
    } else if (m == 'settle') {
      var secret = t[1]
      var hash = sha3(secret)

      var index = outwards.findIndex((hl) => hl[1].equals(hash))
      var hl = outwards[index]

      if (!hl) {
        l('No such hashlock')
        break
      }

      // secret was provided, apply to offdelta
      newState[1][2]++ //nonce
      newState[1][3] += ch.left ? -hl[0] : hl[0]
      receivable += hl[0]
      outwards.splice(index, 1)

      // check new state and sig, save
      if (!await ch.d.saveState(newState, t[2])) {
        l('Invalid state sig settle')
        break
      }

      await ch.d.saveState(newState, t[2])

      var outward = (await ch.d.getPayments({
        where: {hash: hash, is_inward: false},
        include: {all: true}
      }))[0]

      outward.secret = secret
      outward.status = 'settle_sent'
      await outward.save()

      var inward = await Payment.findOne({
        where: {hash: hash, is_inward: true},
        include: {all: true}
      })

      if (inward) {
        l('Found inward to unlock with ', inward.deltum.partnerId)

        inward.secret = secret
        inward.status = 'settle'
        await inward.save()

        uniqAdd(inward.deltum.partnerId)
      } else {
        //react({confirm: 'Payment completed'})
      }

      if (me.handicap_dontsettle) {
        return l(
          'HANDICAP ON: not settling on a given secret, but pulling from inward'
        )
      }
    } else if (m == 'fail') {
      var hash = t[1]

      var index = outwards.findIndex((hl) => hl[1].equals(hash))
      var hl = outwards[index]

      if (!hl) {
        l('No such hashlock')
        break
      }

      // secret wasn't provided, delete lock
      newState[1][2]++ //nonce
      outwards.splice(index, 1)

      // check new state and sig, save
      if (!await ch.d.saveState(newState, t[2])) {
        l('Invalid state sig fail ')
        break
      }

      await ch.d.saveState(newState, t[2])

      var outward = (await ch.d.getPayments({
        where: {hash: hash, is_inward: false},
        include: {all: true}
      }))[0]

      outward.status = 'fail_sent'
      await outward.save()

      var inward = await outward.getInward()

      if (inward) {
        inward.status = 'fail'
        await inward.save()
        uniqAdd(inward.deltum.partnerId)
      } else {
        //react({alert: 'Payment failed'})
      }
    }
  }

  ch.d.status = 'master'
  ch.d.pending = null

  // since we applied partner's diffs, all we need is to add the diff of our own transitions
  if (rollback[0] > 0) {
    ch.d.nonce += rollback[0]
    ch.d.offdelta += rollback[1]
    ch.d.status = 'merge'

    var st = await ch.d.getState()
    l('After rollback we are at: ')
    logstate(st)
  }

  await ch.d.save()

  // If no transitions received, do opportunistic flush (maybe while we were "sent" transitions were added)
  // Otherwise give forced ack to the partner
  await me.flushChannel(ch, transitions.length == 0)

  for (var fl of flushable) {
    var ch = await me.getChannel(fl)
    // can be opportunistic also
    await me.flushChannel(ch, true)
    //await ch.d.requestFlush()
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
