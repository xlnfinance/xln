// Receives an ack and set of transitions to execute on top of it by the partner
module.exports = async (
  pubkey,
  asset,
  ackSig,
  transitions,
  debugState,
  signedState
) => {
  let ch = await me.getChannel(pubkey, asset)
  let all = []

  if (ch.d.status == 'disputed') {
    loff('We are in a dispute')
    return
  }

  let oldState = r(ch.d.signed_state)
  prettyState(oldState)

  prettyState(debugState)
  prettyState(signedState)

  // first, clone what they can pay and decrement
  let receivable = ch.they_payable

  // an array of partners we need to ack or flush changes at the end of processing
  let flushable = []

  // indexOf doesn't work with Buffers
  let uniqAdd = (add) => {
    if (!flushable.find((f) => f.equals(add))) {
      flushable.push(add)
    }
  }

  // this is state we are on right now.
  let newState = await ch.d.getState()

  let rollback = [0, 0]

  if (await ch.d.saveState(newState, ackSig)) {
    // our last known state has been acked.

    all.push(
      Payment.update(
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
    )

    ch.d.ack_requested_at = null
    //loff('Update all sent transitions as acked ')
  } else {
    if (transitions.length == 0) {
      logstates(newState, oldState, debugState, signedState)

      loff('Empty invalid ack')
      return
    }

    if (ch.d.status == 'merge') {
      logstates(newState, oldState, debugState, signedState)

      loff('Rollback cant rollback')
      //gracefulExit('Rollback cant rollback')
      return
    }

    /*

    We received an acksig that doesnt match our current state. Apparently the partner sent
    transitions at the same time we did. 

    Our job is to rollback to last known signed state, check ackSig against it, if true - apply
    partner's transitions, and then reapply the difference we made with OUR transitions
    namely - nonce and offdelta diffs because hashlocks are already processed. 
    
    We hope the partner does the same with our transitions so we both end up on equal states.

    */

    if (ch.d.signed_state && (await ch.d.saveState(oldState, ackSig))) {
      loff(`Start merge ${trim(pubkey)}`)

      rollback = [
        newState[1][2] - oldState[1][2], // nonce diff
        newState[1][3] - oldState[1][3] // offdelta diff
      ]
      newState = oldState
    } else {
      logstates(newState, oldState, debugState, signedState)

      loff('Deadlock?!')
      //gracefulExit('Deadlock?!')
      //await me.flushChannel(ch)

      return
    }
  }

  //logtr(transitions)

  let outwards = newState[ch.left ? 3 : 2]
  let inwards = newState[ch.left ? 2 : 3]
  // we apply a transition to canonical state, if sig is valid - execute the action
  for (let t of transitions) {
    let m = methodMap(readInt(t[0]))

    if (m == 'add') {
      let [amount, hash, exp, destination, unlocker] = t[1]

      exp = readInt(exp)
      amount = readInt(amount)

      let new_type = 'add'

      if (amount < K.min_amount || amount > receivable) {
        loff('Error: invalid amount ', amount)
        new_type = 'fail'
      }

      if (hash.length != 32) {
        loff('Error: Hash must be 32 bytes')
        break
      }

      if (inwards.length >= K.max_hashlocks) {
        loff('Error: too many hashlocks')
        break
      }

      let reveal_until = K.usable_blocks + K.hashlock_exp
      // if usable blocks is 10 and default exp is 5, must be between 14-16

      if (exp < reveal_until - 30 || exp > reveal_until + 30) {
        new_type = 'fail'
        loff('Error: exp is out of supported range')
      }

      receivable -= amount

      // push a hashlock
      inwards.push([amount, hash, exp])

      // check new state and sig, save
      newState[1][2]++
      if (!await ch.d.saveState(newState, t[2])) {
        loff('Error: Invalid state sig add')
        break
      }

      let hl = await ch.d.createPayment({
        type: new_type,
        // we either add add/acked or fail/new
        status: new_type == 'add' ? 'acked' : 'new',
        is_inward: true,

        amount: amount,
        hash: hash,
        exp: exp,

        unlocker: unlocker,
        destination: destination
      })

      if (new_type == 'fail') {
        // go to next transition - we failed this hashlock already
        continue
      }

      // pay to unlocker
      if (destination.equals(me.pubkey)) {
        unlocker = r(unlocker)
        let unlocked = nacl.box.open(
          unlocker[0],
          unlocker[1],
          unlocker[2],
          me.box.secretKey
        )
        if (unlocked == null) {
          loff('Error: Bad unlocker')
          hl.type = 'fail'
          hl.status = 'new'
        } else {
          let [box_amount, box_secret, box_invoice] = r(bin(unlocked))
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
        //loff(`Forward ${amount} to ${trim(destination)}`)
        let outward_amount = afterFees(amount, me.my_hub.fee)

        let dest_ch = await me.getChannel(destination, asset)

        // is online? Is payable?

        if (me.users[destination] && dest_ch.payable >= outward_amount) {
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
        loff('Error: arent receiver and arent a hub O_O')
      }
    } else if (m == 'settle' || m == 'fail') {
      let [secret, hash] = m == 'settle' ? [t[1], sha3(t[1])] : [null, t[1]]

      let index = outwards.findIndex((hl) => hl[1].equals(hash))
      let hl = outwards[index]

      if (!hl) {
        loff('Error: No such hashlock')
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
        gracefulExit('Error: Invalid state sig at ' + m)
        break
      }

      let outward = (await ch.d.getPayments({
        where: {hash: hash, is_inward: false},
        include: {all: true}
      }))[0]

      outward.secret = secret
      outward.type = m
      outward.status = 'acked'

      await outward.save()

      let inward = await outward.getInward()

      if (inward) {
        loff(`Found inward ${trim(inward.deltum.partnerId)}`)

        if (inward.deltum.status == 'disputed') {
          loff(
            'The inward channel is disputed (pointless to flush), which means we revealSecret - by the time of resultion hashlock will be unlocked'
          )
          me.batch.push('revealSecrets', [secret])
        } else {
          // how much fee we just made by mediating the transfer?
          me.metrics.fees.current += inward.amount - outward.amount
          // add to total volume
          me.metrics.volume.current += inward.amount
          // add to settled payments
          me.metrics.settle.current += 1

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
        return
      }
    }
  }

  // since we applied partner's diffs, all we need is to add the diff of our own transitions
  if (rollback[0] > 0) {
    ch.d.nonce += rollback[0]
    ch.d.offdelta += rollback[1]
    ch.d.status = 'merge'
  } else {
    ch.d.status = 'master'
    ch.d.pending = null
  }

  // CHEAT_: storing most profitable outcome for us

  if (!ch.d.CHEAT_profitable_state) {
    ch.d.CHEAT_profitable_state = ch.d.signed_state
    ch.d.CHEAT_profitable_sig = ch.d.sig
  }
  let profitable = r(ch.d.CHEAT_profitable_state)
  let o = readInt(profitable[1][3])
  if ((ch.left && ch.d.offdelta > o) || (!ch.left && ch.d.offdelta < o)) {
    ch.d.CHEAT_profitable_state = ch.d.signed_state
    ch.d.CHEAT_profitable_sig = ch.d.sig
  }

  all.push(ch.d.save())

  await Promise.all(all)

  /*
  ch.d.getState().then((st) => {
    loff(`After ${rollback[0] > 0 ? 'merge' : 'update'}: `, ascii_state(st))
  })
  */

  return flushable

  // If no transitions received, do opportunistic flush (maybe while we were "sent" transitions were added)
  // Otherwise give forced ack to the partner
}
