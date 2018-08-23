// This method receives set of transitions by another party and applies it
// hubs normally pass forward payments, end users normally decode payloads and unlock hashlocks
module.exports = async (pubkey, asset, ackSig, transitions, debug) => {
  let ch = await me.getChannel(pubkey, asset)
  ch.last_used = ts()

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

  let [theirInitialState, theirFinalState, theirSignedState] = debug

  let ourSignedState = r(ch.d.signed_state)
  prettyState(ourSignedState)

  prettyState(theirInitialState)
  prettyState(theirFinalState)
  prettyState(theirSignedState)

  if (deltaVerify(ch.d, refresh(ch), ackSig)) {
    // our last known state has been ack.
    ch.payments.map((t, ind) => {
      if (t.status == 'sent') t.status = 'ack'
    })

    ch.d.ack_requested_at = null

    //l('Nullify ack for ', ch.d.ack_requested_at, trim(pubkey))

    if (trace)
      l('Received ack on current state, all sent transitions are now ack')
  } else {
    if (ch.d.status == 'merge') {
      // we are in merge and yet we just received ackSig that doesnt ack latest state
      logstates(ch.state, ourSignedState, theirInitialState, theirSignedState)
      fatal('Rollback cant rollback')
      return
    }
    if (transitions.length == 0) {
      logstates(ch.state, ourSignedState, theirInitialState, theirSignedState)
      fatal('Empty invalid ack ' + ch.d.status)
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

    if (ch.d.signed_state && deltaVerify(ch.d, ourSignedState, ackSig)) {
      if (trace) l(`Start merge with ${trim(pubkey)}`)

      ch.rollback = [
        ch.d.nonce - ourSignedState[1][2], // nonce diff
        ch.d.offdelta - ourSignedState[1][3] // offdelta diff
      ]
      ch.d.nonce = ourSignedState[1][2]
      ch.d.offdelta = ourSignedState[1][3]
    } else {
      logstates(ch.state, ourSignedState, theirInitialState, theirSignedState)

      l('Deadlock')

      //fatal('Deadlock?!')
      //await me.flushChannel(ch)

      return
    }
  }

  // we apply a transition to canonical state, if sig is valid - execute the action
  for (let t of transitions) {
    let m = methodMap(readInt(t[0]))

    if (m == 'add' || m == 'addrisk') {
      let [amount, hash, exp, unlocker] = t[1]
      ;[exp, amount] = [exp, amount].map(readInt)
      // every 'add' transition must pass an encrypted envelope (onion routing)

      let box_data = open_box_json(unlocker)

      // it contains amount/asset you are expected to get
      // ensure to 'del' if there's any problem, or it will hang in your state forever
      if (!box_data || box_data.amount != amount || box_data.asset != asset) {
        loff('error: Bad data received: ', box_data)
        inward_hl.type = m == 'add' ? 'del' : 'delrisk'
        inward_hl.status = 'new'

        continue
      }

      let new_type = m

      if (amount < K.min_amount || amount > ch.they_payable) {
        loff('error: invalid amount ', amount)
        new_type = m == 'add' ? 'del' : 'delrisk'
      }

      if (hash.length != 32) {
        loff('error: Hash must be 32 bytes')
        break
      }

      if (ch.inwards.length >= K.max_hashlocks) {
        loff('error: too many hashlocks')
        break
      }

      let reveal_until = K.usable_blocks + K.hashlock_exp
      // safe ranges when we can accept hashlock exp
      // not earlier than few blocks in the past, but many in the future is fine
      // we do not break here (it can happen during normal operation) and simply delack this payment
      if (exp < reveal_until - 2 || exp > reveal_until + 6) {
        new_type = m == 'add' ? 'del' : 'delrisk'
        loff(`error: exp is out of supported range: ${exp} vs ${reveal_until}`)
      }

      // don't save in db just yet
      let inward_hl = Payment.build({
        type: new_type,
        // we either add add/addrisk or del right away
        status: new_type == m ? 'ack' : 'new',
        is_inward: true,

        amount: amount,
        hash: bin(hash),
        exp: exp,

        asset: asset,

        deltumId: ch.d.id
      })

      ch.payments.push(inward_hl)

      if (m == 'add') {
        // push a hashlock in-state
      } else {
        // off-state
        ch.d.offdelta += ch.left ? amount : -amount
      }

      // check new state and sig, save
      ch.d.nonce++
      if (!deltaVerify(ch.d, refresh(ch), t[2])) {
        loff('error: Invalid state sig add')
        logstates(ch.state, ourSignedState, theirInitialState, theirSignedState)

        break
      }

      if (new_type != m) {
        l('Fail for no reason')
        // go to next transition - we failed this hashlock already
      } else if (!box_data.unlocker && box_data.secret) {
        // we are final destination, no unlocker to pass

        // decode buffers from json
        box_data.secret = fromHex(box_data.secret)
        box_data.invoice = fromHex(box_data.invoice)

        // optional refund address
        inward_hl.source_address = box_data.source_address

        inward_hl.invoice = box_data.invoice

        // secret doesn't fit?
        if (sha3(box_data.secret).equals(hash)) {
          inward_hl.secret = box_data.secret
        } else {
          l('box mismatch: secret')
          inward_hl.secret = bin('box mismatch: secret')
        }

        inward_hl.type = m == 'add' ? 'del' : 'delrisk'
        inward_hl.status = 'new'

        if (trace) l(`Received and unlocked a payment, changing addack->delnew`)

        // at this point we reveal the secret from the box down the chain of senders,
        // there is a chance the partner does not ACK our del on time and
        // the hashlock expires making us lose the money.
        // SECURITY: if after timeout the del is not ack, go to blockchain ASAP to reveal the preimage. See ensure_ack

        // no need to add to flushable - secret will be returned during ack to sender anyway
      } else if (me.my_hub && box_data.nextHop) {
        loff(`Forward ${amount} to ${box_data.nextHop}`)
        let outward_amount = afterFees(amount, me.my_hub)

        // ensure it's equal what they expect us to pay
        let nextHop = fromHex(box_data.nextHop)

        let dest_ch = await me.getChannel(nextHop, asset)

        // is next hop online? Is payable?
        if (
          me.users[nextHop] &&
          dest_ch.status != 'disputed' &&
          dest_ch.payable >= outward_amount
        ) {
          var outward_hl = Payment.build({
            deltumId: dest_ch.d.id,
            type: m,
            status: 'new',
            is_inward: false,

            amount: outward_amount,
            hash: bin(hash),
            exp: exp,

            asset: asset,

            // we pass nested unlocker for them
            unlocker: fromHex(box_data.unlocker),

            inward_pubkey: bin(pubkey)
          })
          dest_ch.payments.push(outward_hl)

          if (trace)
            l(`Mediating ${outward_amount} payment to ${trim(nextHop)}`)

          //if (argv.syncdb) all.push(outward_hl.save())

          uniqAdd(dest_ch.d.partnerId)
        } else {
          l('Failed to mediate')
          inward_hl.secret = bin('nope')
          // fail right now
          inward_hl.type = m == 'add' ? 'del' : 'delrisk'
          inward_hl.status = 'new'

          me.metrics.fail.current++
        }
      } else {
        inward_hl.type = m == 'add' ? 'del' : 'delrisk'
        inward_hl.status = 'new'

        loff('error: arent receiver and arent a hub O_O')
      }

      //if (argv.syncdb) all.push(inward_hl.save())
    } else if (m == 'del' || m == 'delrisk') {
      var [hash, outcome] = t[1]

      // try to parse outcome as secret and check its hash
      if (outcome.length == K.secret_len && sha3(outcome).equals(hash)) {
        var valid = true
      } else {
        // otherwise it is a reason why mediation failed
        var valid = false
      }

      l('Got outcome: ', outcome.length)

      // todo check expirations
      var outward_hl = ch.outwards.find((hl) => hl.hash.equals(hash))
      if (!outward_hl) {
        fatal('No such hashlock ', hash)
        continue
      }

      if (valid && m == 'del') {
        // secret was provided - remove & apply hashlock on offdelta
        ch.d.offdelta += ch.left ? -outward_hl.amount : outward_hl.amount
      } else if (!valid && m == 'delrisk') {
        // delrisk fail is refund
        ch.d.offdelta += ch.left ? outward_hl.amount : -outward_hl.amount
      }

      outward_hl.type = m
      outward_hl.status = 'ack'
      // pass same outcome down the chain
      outward_hl.secret = outcome

      ch.d.nonce++
      if (!deltaVerify(ch.d, refresh(ch), t[2])) {
        fatal('error: Invalid state sig at ' + m)
        break
      }

      me.metrics[valid ? 'settle' : 'fail'].current++

      //if (argv.syncdb) all.push(outward_hl.save())

      // if there's an inward channel for this, we are hub
      if (outward_hl.inward_pubkey) {
        var inward = await me.getChannel(outward_hl.inward_pubkey, ch.d.asset)

        if (inward.d.status == 'disputed' && valid) {
          loff(
            'The inward channel is disputed (pointless to flush), which means we revealSecret - by the time of resultion hashlock will be unlocked'
          )
          me.batch.push(['revealSecrets', [outcome]])
        } else {
          // pulling the money after receiving secrets, down the chain of channels
          var pull_hl = inward.inwards.find((hl) => hl.hash.equals(hash))

          if (!pull_hl) {
            l(
              `error: Not found pull`,
              trim(pubkey),
              toHex(hash),
              valid,
              inward.rollback,
              ascii_state(inward.state)
            )
            continue
            //fatal('Not found pull hl')
          }
          // pass same outcome down the chain

          pull_hl.secret = outcome
          pull_hl.type = 'del'
          pull_hl.status = 'new'
          //if (argv.syncdb) all.push(pull_hl.save())

          if (trace)
            l(
              `Received a secret from ${trim(
                pubkey
              )}, acking and pulling inward payment`
            )
          uniqAdd(outward_hl.inward_pubkey)

          // how much fee we just made by mediating the transfer?
          me.metrics.fees.current += pull_hl.amount - outward_hl.amount
          // add to total volume
          me.metrics.volume.current += pull_hl.amount
        }
      } else {
        if (valid) {
          react(
            {payment_outcome: 'success', confirm: 'Payment completed'},
            false
          )
        } else {
          // if not a hub, we are sender
          react(
            {
              payment_outcome: 'fail',
              alert: 'Payment failed, try another route: ' + outcome.toString()
            },
            false
          )
        }
      }

      if (me.CHEAT_dontack) {
        l('CHEAT: not acking the secret, but pulling from inward')
        ch.d.status = 'CHEAT_dontack'
        await ch.d.save()
        react({}, false) // lazy react
        return
      }
    }
  }

  let ours = ascii_state(ch.state)
  let theirs = ascii_state(theirFinalState)

  if (ours != theirs) {
    l(ours, theirs)
    fatal('Unexpected final states after transitions ', transitions)
  }

  // since we applied partner's diffs, all we need is to add the diff of our own transitions
  if (ch.rollback[0] > 0) {
    // merging and leaving rollback mode
    ch.d.nonce += ch.rollback[0]
    ch.d.offdelta += ch.rollback[1]
    ch.rollback = [0, 0]

    if (trace) l(`After merge our state is \n${ascii_state(refresh(ch))}`)

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

  //if (argv.syncdb) {
  //all.push(ch.d.save())

  //await syncdb() //Promise.all(all)
  //}

  return flushable

  // If no transitions received, do opportunistic flush, otherwise give forced ack
}
