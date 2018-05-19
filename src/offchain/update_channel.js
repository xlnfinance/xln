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

  // an array of partners we need to ack or flush changes at the end of processing
  var flushable = []

  // indexOf doesn't work with Buffers
  let uniqAdd = (add) => {
    if (flushable.find((f) => f.equals(add))) {
      //loff('Already scheduled for flush')
    } else {
      flushable.push(add)
    }
  }

  let oldState = r(ch.d.signed_state)
  prettyState(oldState)

  prettyState(debugState)
  prettyState(signedState)

  if (ch.d.saveState(refresh(ch), ackSig)) {
    // our last known state has been acked.
    ch.payments.map((t) => {
      if (t.status == 'sent') t.status = 'acked'
    })

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
    if (ch.d.status == 'merge') {
      // we are in merge and yet we just received ackSig that doesnt ack latest state
      loff('Rollback cant rollback')
      logstates(ch.state, oldState, debugState, signedState)
      //gracefulExit('Rollback cant rollback')
      return
    }
    if (transitions.length == 0) {
      loff('Empty invalid ack, ' + ch.d.status)
      logstates(ch.state, oldState, debugState, signedState)
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

    if (ch.d.signed_state && ch.d.saveState(oldState, ackSig)) {
      //loff(`Start merge ${trim(pubkey)}`)

      ch.rollback = [
        ch.d.nonce - oldState[1][2], // nonce diff
        ch.d.offdelta - oldState[1][3] // offdelta diff
      ]
      ch.d.nonce = oldState[1][2]
      ch.d.offdelta = oldState[1][3]

      /*
      // rolling back to last signed hashlocks
      ch.inwards = ch.old_inwards
      ch.outwards = ch.old_outwards
      */
    } else {
      logstates(ch.state, oldState, debugState, signedState)

      loff('Deadlock?!')
      //gracefulExit('Deadlock?!')
      //await me.flushChannel(ch)

      return
    }
  }

  //ascii_tr(transitions)
  // we apply a transition to canonical state, if sig is valid - execute the action
  for (let t of transitions) {
    let m = methodMap(readInt(t[0]))

    if (m == 'add' || m == 'addrisk') {
      let [amount, hash, exp, destination, unlocker] = t[1]
      ;[exp, amount] = [exp, amount].map(readInt)

      let new_type = m

      if (amount < K.min_amount || amount > ch.they_payable) {
        loff('Error: invalid amount ', amount)
        new_type = m == 'add' ? 'fail' : 'failrisk'
      }

      if (hash.length != 32) {
        loff('Error: Hash must be 32 bytes')
        break
      }

      if (ch.inwards.length >= K.max_hashlocks) {
        loff('Error: too many hashlocks')
        break
      }

      let reveal_until = K.usable_blocks + K.hashlock_exp
      // safe ranges when we can accept hashlock exp

      /*
      if (exp < reveal_until - 2 || exp > reveal_until + 5) {
        new_type = m == 'add' ? 'fail' : 'failrisk'
        loff('Error: exp is out of supported range')
      }
      */

      // don't save in db just yet
      let hl = Payment.build({
        type: new_type,
        // we either add add/addrisk or fail right away
        status: new_type == m ? 'acked' : 'new',
        is_inward: true,

        amount: amount,
        hash: hash,
        exp: exp,

        unlocker: unlocker,
        destination: destination,

        deltumId: ch.d.id
      })
      ch.payments.push(hl)

      /*

      if (m == 'add') {
        // push a hashlock in-state
        ch.inwards.push(hl)
      } else {
        // off-state
        ch.d.offdelta += ch.left ? amount : -amount
      }
      */

      // check new state and sig, save
      ch.d.nonce++
      if (!ch.d.saveState(refresh(ch), t[2])) {
        loff('Error: Invalid state sig add')
        logstates(ch.state, oldState, debugState, signedState)

        break
      }

      await hl.save()

      if (new_type != m) {
        // go to next transition - we failed this hashlock already
        continue
      }

      // pay to unlocker
      if (destination.equals(me.pubkey)) {
        unlocker = r(unlocker)
        let unlocked = unlocker[0]
        /*nacl.box.open(
          unlocker[0],
          unlocker[1],
          unlocker[2],
          me.box.secretKey
        )*/
        if (unlocked == null) {
          loff('Error: Bad unlocker')
          hl.type = m == 'add' ? 'fail' : 'failrisk'
          hl.status = 'new'
        } else {
          let [box_amount, box_secret, box_invoice] = r(bin(unlocked))
          box_amount = readInt(box_amount)

          hl.invoice = box_invoice

          hl.secret = box_secret
          hl.type = m == 'add' ? 'settle' : 'settlerisk'
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
          dest_ch.payments.push(
            await dest_ch.d.createPayment({
              type: m,
              status: 'new',
              is_inward: false,

              amount: outward_amount,
              hash: hash,
              exp: exp, // the outgoing exp is a little bit longer

              unlocker: unlocker,
              destination: destination,
              inward_pubkey: pubkey
            })
          )

          uniqAdd(dest_ch.d.partnerId)
        } else {
          hl.type = m == 'add' ? 'fail' : 'failrisk'
          hl.status = 'new'
          await hl.save()
        }
      } else {
        loff('Error: arent receiver and arent a hub O_O')
      }
    } else if (
      m == 'settle' ||
      m == 'fail' ||
      m == 'settlerisk' ||
      m == 'failrisk'
    ) {
      let [secret, hash] =
        m == 'settle' || m == 'settlerisk' ? [t[1], sha3(t[1])] : [null, t[1]]

      /*
      let outward = (await ch.d.getPayments({
        where: {
          hash: hash,
          is_inward: false,
          type: m.includes('risk') ? 'addrisk' : 'add'
        }
      }))[0]

      if (!outward) {
        loff('Error: No such payment')
        break
      }
      */

      // todo check expirations
      let hl = ch.outwards.find((hl) => hl.hash.equals(hash))
      if (!hl) continue

      if (m == 'settle' || m == 'fail') {
        if (m == 'settle') {
          // secret was provided - remove & apply hashlock on offdelta
          ch.d.offdelta += ch.left ? -hl.amount : hl.amount
        } else {
          // secret wasn't provided, just delete lock
        }
      } else if (m == 'failrisk') {
        // note that settlerisk is not state changing at all, and failrisk is refund
        ch.d.offdelta += ch.left ? hl.amount : -hl.amount
      }

      hl.secret = secret
      hl.type = m
      hl.status = 'acked'

      ch.d.nonce++
      if (!ch.d.saveState(refresh(ch), t[2])) {
        gracefulExit('Error: Invalid state sig at ' + m)
        break
      }

      all.push(hl.save())

      if (hl.inward_pubkey) {
        //loff(`Found inward ${trim(inward.deltum.partnerId)}`)
        var inward = await me.getChannel(hl.inward_pubkey, ch.d.asset)

        if (inward.d.status == 'disputed') {
          loff(
            'The inward channel is disputed (pointless to flush), which means we revealSecret - by the time of resultion hashlock will be unlocked'
          )
          me.batch.push('revealSecrets', [secret])
        } else {
          /*
          // how much fee we just made by mediating the transfer?
          me.metrics.fees.current += inward.amount - hl.amount
          // add to total volume
          me.metrics.volume.current += inward.amount
          // add to settled payments*/
          me.metrics.settle.current += 1

          var inhl = inward.payments.find((inhl) => inhl.hash.equals(hl.hash))

          inhl.secret = secret
          inhl.type = m
          inhl.status = 'new'
          await inhl.save()

          uniqAdd(hl.inward_pubkey)
        }
      } else {
        //react({confirm: 'Payment completed'})
      }

      /*
      if (me.CHEAT_dontack) {
        l('CHEAT: not acking the secret, but pulling from inward')
        ch.d.status = 'CHEAT_dontack'
        await ch.d.save()
        react({}, false) // lazy react
        return
      }
      */
    }
  }

  // since we applied partner's diffs, all we need is to add the diff of our own transitions
  if (ch.rollback[0] > 0) {
    /*
    for (var t of ch.sent) {
      if (t.type == 'add') {
        ch.outwards.push(t)
      } else {
        ch.inwards = ch.inwards.filter((c) => c != t)
      }
    }*/

    ch.d.nonce += ch.rollback[0]
    ch.d.offdelta += ch.rollback[1]

    // leaving rollback mode: our sents will auto appear in state
    ch.rollback = [0, 0]

    l('After rollback ', ascii_state(refresh(ch)))

    ch.d.status = 'merge'
  } else {
    ch.d.status = 'master'
    ch.d.pending = null
  }

  // CHEAT_: storing most profitable outcome for us
  /*
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
  */

  all.push(ch.d.save())

  await Promise.all(all)

  return flushable

  // If no transitions received, do opportunistic flush (maybe while we were "sent" transitions were added)
  // Otherwise give forced ack to the partner
}
