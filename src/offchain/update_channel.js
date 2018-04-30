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

  var _ = await lock(toHex(pubkey))

  var ch = await me.getChannel(pubkey)

  if (ch.d.status == 'disputed') {
    l('We are in a dispute')
    return _()
  }

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

  if (await ch.d.saveState(newState, ackSig)) {
    // our last known state has been acked.

    await Payment.update(
      {
        status: 'acked'
      },
      {
        where: {
          status: 'sent',
          deltumId: ch.d.id
        }
      }
    )

    ch.d.ack_requested_at = null
    //l('Update all sent transitions as acked ', ch.d.ack_requested_at)
    await ch.d.save()
  } else {
    if (transitions.length == 0) {
      l('Empty invalid ack')
      return _()
      logstate(newState)
      logstate(oldState)
      logstate(debugState)
      logstate(signedState)
    }

    if (ch.d.status == 'merge') {
      l('Rollback cant rollback')
      return _()
    }

    /*

    We received an acksig that doesnt match our current state. Apparently the partner sent
    transitions at the same time we did. 

    Our job is to rollback to last known signed state, check ackSig against it, if true - apply
    partner's transitions, and then reapply the difference we made with OUR transitions
    namely - nonce and offdelta diffs because hashlocks are already processed. 
    
    We hope the partner does the same with our transitions so we both end up on equal states.

    */

    if (await ch.d.saveState(oldState, ackSig)) {
      l('Rollback to old state')

      rollback = [
        newState[1][2] - oldState[1][2], // nonce diff
        newState[1][3] - oldState[1][3] // offdelta diff
      ]
      newState = oldState
    } else {
      logstate(newState)
      logstate(oldState)
      logstate(debugState)
      logstate(signedState)

      l('Dead lock?! Trying to recover by sending last ack')
      //await me.flushChannel(ch)

      return _()
    }
  }

  logtr(transitions)

  var outwards = newState[ch.left ? 3 : 2]
  var inwards = newState[ch.left ? 2 : 3]
  // we apply a transition to canonical state, if sig is valid - execute the action
  for (var t of transitions) {
    var m = methodMap(readInt(t[0]))

    if (m == 'add') {
      var [amount, hash, exp, destination, unlocker] = t[1]

      exp = readInt(exp)
      amount = readInt(amount)

      var new_type = 'add'

      if (amount < K.min_amount || amount > receivable) {
        l('Invalid amount ', amount)
        new_type = 'fail'
      }

      if (hash.length != 32) {
        l('Hash must be 32 bytes')
        return _()
      }

      if (inwards.length >= K.max_hashlocks) {
        l('You try to set too many hashlocks')
        return _()
      }

      var reveal_until = K.usable_blocks + K.hashlock_exp
      // if usable blocks is 10 and default exp is 5, must be between 14-16

      if (exp < reveal_until - 2 || exp > reveal_until + 2) {
        new_type = 'fail'
        l('Expiration is out of supported range')
      }

      receivable -= amount

      // push a hashlock
      inwards.push([amount, hash, exp])

      // check new state and sig, save
      newState[1][2]++
      if (!await ch.d.saveState(newState, t[2])) {
        l('Invalid state sig add')
        return _()
      }

      var hl = await ch.d.createPayment({
        type: new_type,
        status: new_type == 'add' ? 'acked' : 'new',
        is_inward: true,

        amount: amount,
        hash: hash,
        exp: exp,

        unlocker: unlocker
      })

      if (new_type == 'fail') {
        // go to next transition - we failed this hashlock already
        continue
      }

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
          hl.type = 'fail'
          hl.status = 'new'
        } else {
          var [box_amount, box_secret, box_invoice] = r(bin(unlocked))
          box_amount = readInt(box_amount)

          //react({confirm: 'Received a payment'})
          hl.invoice = box_invoice

          hl.secret = box_secret
          hl.type = 'settle'
          hl.status = 'new'

          // at this point we reveal the secret from the box down the chain of senders, there is a chance the partner does not ACK our settle on time and the hashlock expires making us lose the money.
          // SECURITY: if after timeout the settle is not acked, go to blockchain ASAP to reveal the preimage!
        }

        await hl.save()

        // no need to add to flushable - secret will be returned during ack to sender anyway
      } else if (me.my_hub) {
        l(`Forward ${amount} to peer or other hub ${toHex(destination)}`)
        var outward_amount = afterFees(amount, me.my_hub.fee)

        var dest_ch = await me.getChannel(destination)

        // is online? Is payable?

        if (me.users[destination] && dest_ch.payable >= outward_amount) {
          await dest_ch.d.save()

          await dest_ch.d.createPayment({
            type: 'add',
            status: 'new',
            is_inward: false,

            amount: outward_amount,
            hash: hash,
            exp: reveal_until, // the outgoing exp is a little bit longer

            unlocker: unlocker,
            destination: destination
          })

          uniqAdd(dest_ch.d.partnerId)
        } else {
          hl.type = 'fail'
          hl.status = 'new'
          await hl.save()
        }
      } else {
        l('We arent receiver and arent a hub O_O')
      }
    } else if (m == 'settle' || m == 'fail') {
      if (m == 'settle') {
        var secret = t[1]
        var hash = sha3(secret)
      } else {
        var secret = null
        var hash = t[1]
      }

      var index = outwards.findIndex((hl) => hl[1].equals(hash))
      var hl = outwards[index]

      if (!hl) {
        l('No such hashlock')
        break
      }

      outwards.splice(index, 1)

      if (m == 'settle') {
        // secret was provided - remove & apply hashlock on offdelta
        newState[1][3] += ch.left ? -hl[0] : hl[0]
        receivable += hl[0]
      } else {
        // secret wasn't provided, delete lock
      }

      // check new state and sig, save
      newState[1][2]++
      if (!await ch.d.saveState(newState, t[2])) {
        l('Invalid state sig at ' + m)
        break
      }

      var outward = (await ch.d.getPayments({
        where: {hash: hash, is_inward: false},
        include: {all: true}
      }))[0]

      outward.secret = secret
      outward.type = m
      outward.status = 'acked'

      await outward.save()

      var inward = await outward.getInward()

      if (inward) {
        l('Found inward ', inward.deltum.partnerId)

        if (inward.deltum.status == 'disputed') {
          l(
            'The inward channel is disputed (pointless to flush), which means we revealSecret - by the time of resultion hashlock will be unlocked'
          )
          me.batch.push('revealSecrets', [secret])
        } else {
          inward.secret = secret
          inward.type = m
          inward.status = 'new'
          await inward.save()

          uniqAdd(inward.deltum.partnerId)
        }
      } else {
        //react({confirm: 'Payment completed'})
      }

      if (me.CHEAT_dontack) {
        l('CHEAT: not acking the secret, but pulling from inward')
        ch.d.status = 'CHEAT_dontack'
        await ch.d.save()
        react()
        return _()
      }
    }
  }

  // since we applied partner's diffs, all we need is to add the diff of our own transitions
  if (rollback[0] > 0) {
    ch.d.nonce += rollback[0]
    ch.d.offdelta += rollback[1]
    ch.d.status = 'merge'

    var st = await ch.d.getState()
    l('After rollback we are at: ')
    logstate(st)
  } else {
    ch.d.status = 'master'
    ch.d.pending = null
  }

  // CHEAT_: storing most profitable outcome for us
  if (!ch.d.CHEAT_profitable_state) {
    ch.d.CHEAT_profitable_state = ch.d.signed_state
    ch.d.CHEAT_profitable_sig = ch.d.sig
  }
  var profitable = r(ch.d.CHEAT_profitable_state)
  var o = readInt(profitable[1][3])
  if ((ch.left && ch.d.offdelta > o) || (!ch.left && ch.d.offdelta < o)) {
    ch.d.CHEAT_profitable_state = ch.d.signed_state
    ch.d.CHEAT_profitable_sig = ch.d.sig
  }

  await ch.d.save()

  _()

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
}
