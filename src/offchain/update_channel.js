// This method receives set of transitions by another party and applies it
// hubs normally pass forward payments, end users normally decode payloads and unlock hashlocks
module.exports = async (pubkey, ackSig, transitions, debug) => {
  let ch = await Channel.get(pubkey)
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

  let ourSignedState = r(ch.d.signed_state)
  prettyState(ourSignedState)

  // decode from hex and unpack
  let theirSignedState = debug[0] ? r(fromHex(debug[0])) : false
  prettyState(theirSignedState)

  let theirState = debug[1] ? r(fromHex(debug[1])) : false
  prettyState(theirState)

  let mismatch = (reason) => {
    logstates(
      reason,
      ch.state,
      theirState,
      ourSignedState,
      theirSignedState,
      transitions
    )
  }

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
      mismatch('Rollback cant rollback')

      fatal('Rollback cant rollback')
      return
    }
    if (transitions.length == 0) {
      mismatch('Empty invalid ack ' + ch.d.status)
      fatal('Empty invalid ack ' + ch.d.status)
      return
    }

    /*
    We received an acksig that doesnt match our current state. Apparently the partner sent
    transitions at the same time we did.

    Our job is to rollback to last known signed state, check ackSig against it, if true - apply
    partner's transitions, and then reapply the difference we made with OUR transitions
    namely - dispute_nonce and offdelta diffs because hashlocks are already processed.

    We hope the partner does the same with our transitions so we both end up on equal states.

    */

    if (ch.d.signed_state && ackSig.equals(ch.d.sig)) {
      //if (trace)

      ch.d.rollback_nonce = ch.d.dispute_nonce - ourSignedState[1][2]
      ch.d.dispute_nonce = ourSignedState[1][2]

      // resetting offdeltas in subchannels back to last signed state
      ch.d.subchannels.map((subch) => {
        let signed_offdelta = ourSignedState[2].find(
          (signed) => signed[0] == subch.asset
        )[1]
        subch.rollback_offdelta = subch.offdelta - signed_offdelta
        subch.offdelta = signed_offdelta
      })

      l(`Start merge with ${trim(pubkey)}, rollback ${ch.d.rollback_nonce}`)
    } else {
      mismatch('Deadlock')

      l('Deadlock')

      fatal('Deadlock?!')
      //await me.flushChannel(ch)

      return
    }
  }

  // we apply a transition to canonical state, if sig is valid - execute the action
  for (let t of transitions) {
    ackSig = fromHex(t[2])

    if (t[0] == 'add' || t[0] == 'addrisk') {
      let [asset, amount, hash, exp, unlocker] = t[1]
      ;[hash, unlocker] = [hash, unlocker].map(fromHex)

      var derived = ch.derived[asset]
      if (!derived) {
        l('no derived')
        continue
      }
      // every 'add' transition must pass an encrypted envelope (onion routing)

      let box_data = open_box_json(unlocker)

      // these things CANT happen, partner is malicious so just ignore and break
      if (amount < K.min_amount || amount > derived.they_payable) {
        l('Bad amount: ', amount, derived.they_payable)
        break
      }
      if (hash.length != 32) {
        break
      }
      if (derived.inwards.length >= K.max_hashlocks) {
        break
      }

      // don't save in db just yet
      let inward_hl = Payment.build({
        // we either add add/addrisk or del right away
        type: 'add',
        status: 'ack',
        is_inward: true,

        amount: amount,
        hash: hash,
        exp: exp,

        asset: asset,

        channelId: ch.d.id
      })

      ch.payments.push(inward_hl)

      // check new state and sig, save
      ch.d.dispute_nonce++
      let nextState = refresh(ch)

      if (!deltaVerify(ch.d, nextState, ackSig)) {
        loff('error: Invalid state sig add')
        let theirState = r(fromHex(t[3]))
        prettyState(theirState)
        mismatch('error: Invalid state sig add', theirState)

        break
      }

      let failure = false

      // it contains amount/asset you are expected to get
      // ensure to 'del' if there's any problem, or it will hang in your state forever

      // things below can happen even when partner is honest
      if (!box_data) {
        failure = 'NoBox'
      }

      if (box_data.amount != amount) {
        failure = 'WrongAmount'
      }

      if (box_data.asset != asset) {
        failure = 'WrongAsset'
      }

      if (!me.my_hub && !box_data.secret) {
        failure = 'NotHubNotReceiver'
      }

      let reveal_until = K.usable_blocks + K.hashlock_exp
      // safe ranges when we can accept hashlock exp
      if (exp < reveal_until - 2 || exp > reveal_until + 6) {
        loff(`error: exp is out of supported range: ${exp} vs ${reveal_until}`)
        failure = 'BadExp'
      }

      if (failure) {
        l('Fail: ', failure)
        // go to next transition - we failed this hashlock already
        inward_hl.type = 'del'
        inward_hl.status = 'new'
        inward_hl.outcome_type = 'outcomeCapacity'
        inward_hl.outcome = bin(failure)
      } else if (box_data.secret) {
        // we are final destination, no unlocker to pass

        // decode buffers from json
        box_data.secret = fromHex(box_data.secret)
        box_data.invoice = fromHex(box_data.invoice)

        // optional refund address
        inward_hl.source_address = box_data.source_address

        inward_hl.invoice = box_data.invoice

        // secret doesn't fit?
        if (sha3(box_data.secret).equals(hash)) {
          inward_hl.outcome_type = 'outcomeSecret'
          inward_hl.outcome = box_data.secret
        } else {
          inward_hl.outcome_type = 'outcomeCapacity'
          inward_hl.outcome = bin('BadSecret')
        }

        inward_hl.type = 'del'
        inward_hl.status = 'new'

        if (trace) l(`Received and unlocked a payment, changing addack->delnew`)

        // at this point we reveal the secret from the box down the chain of senders,
        // there is a chance the partner does not ACK our del on time and
        // the hashlock expires making us lose the money.
        // SECURITY: if after timeout the del is not ack, go to blockchain ASAP to reveal the preimage. See ensure_ack

        // no need to add to flushable - secret will be returned during ack to sender anyway
      } else if (me.my_hub && box_data.nextHop) {
        //loff(`Forward ${amount} to ${box_data.nextHop}`)
        let outward_amount = afterFees(amount, me.my_hub)

        // ensure it's equal what they expect us to pay
        let nextHop = fromHex(box_data.nextHop)

        let dest_ch = await Channel.get(nextHop)

        // is next hop online? Is payable?
        if (!me.users[nextHop]) {
          inward_hl.outcome_type = 'outcomeOffline'
        }

        if (dest_ch.d.status == 'disputed') {
          inward_hl.outcome_type = 'outcomeDisputed'
        }

        if (dest_ch.derived[asset].payable < outward_amount) {
          inward_hl.outcome_type = 'outcomeCapacity'
        }

        if (inward_hl.outcome_type) {
          l('Failed to mediate')
          inward_hl.outcome = bin(`id`)
          // fail right now
          inward_hl.type = t[0] == 'add' ? 'del' : 'delrisk'
          inward_hl.status = 'new'

          me.metrics.fail.current++

          continue
        }

        // otherwise mediate

        var outward_hl = Payment.build({
          channelId: dest_ch.d.id,
          type: t[0],
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

        if (trace) l(`Mediating ${outward_amount} payment to ${trim(nextHop)}`)

        //if (argv.syncdb) all.push(outward_hl.save())

        uniqAdd(dest_ch.d.partnerId)
      } else {
        inward_hl.type = 'del'
        inward_hl.status = 'new'
        inward_hl.outcome_type = 'outcomeCapacity'
        inward_hl.outcome = bin('UnknownError')
      }

      //if (argv.syncdb) all.push(inward_hl.save())
    } else if (t[0] == 'del' || t[0] == 'delrisk') {
      var [asset, hash, outcome_type, outcome] = t[1]
      ;[hash, outcome] = [hash, outcome].map(fromHex)

      // try to parse outcome as secret and check its hash
      if (outcome_type == 'outcomeSecret' && sha3(outcome).equals(hash)) {
        var valid = true
      } else {
        // otherwise it is a reason why mediation failed
        var valid = false
      }

      refresh(ch)

      // todo check expirations
      var outward_hl = ch.derived[asset].outwards.find((hl) =>
        hl.hash.equals(hash)
      )
      if (!outward_hl) {
        l('No such hashlock ', hash, ch.payments)
        continue
      }
      let subch = ch.d.subchannels.by('asset', asset)
      if (valid && t[0] == 'del') {
        // secret was provided - remove & apply hashlock on offdelta
        subch.offdelta += ch.d.isLeft() ? -outward_hl.amount : outward_hl.amount
      } else if (!valid && t[0] == 'delrisk') {
        // delrisk fail is refund
        subch.offdelta += ch.d.isLeft() ? outward_hl.amount : -outward_hl.amount
      }

      outward_hl.type = t[0]
      outward_hl.status = 'ack'
      // pass same outcome down the chain
      outward_hl.outcome_type = outcome_type
      outward_hl.outcome = outcome

      ch.d.dispute_nonce++
      if (!deltaVerify(ch.d, refresh(ch), ackSig)) {
        fatal('error: Invalid state sig at del')
        break
      }

      me.metrics[valid ? 'settle' : 'fail'].current++

      //if (argv.syncdb) all.push(outward_hl.save())

      // if there's an inward channel for this, we are hub
      if (outward_hl.inward_pubkey) {
        var inward_ch = await Channel.get(outward_hl.inward_pubkey)

        if (inward_ch.d.status == 'disputed' && valid) {
          loff(
            'The inward channel is disputed (pointless to flush), which means we revealSecret - by the time of resultion hashlock will be unlocked'
          )
          me.batchAdd('revealSecrets', outcome)
        } else {
          // pulling the money after receiving secrets, down the chain of channels
          var pull_hl = inward_ch.derived[asset].inwards.find((hl) =>
            hl.hash.equals(hash)
          )

          if (!pull_hl) {
            l(
              `error: Not found pull`,
              trim(pubkey),
              toHex(hash),
              valid,
              inward_ch.d.rollback_nonce,
              ascii_state(inward_ch.state)
            )
            continue
            //fatal('Not found pull hl')
          }
          // pass same outcome down the chain

          pull_hl.outcome_type = outcome_type
          pull_hl.outcome = outcome
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
              alert:
                'Payment failed, try another route: ' +
                outcome_type +
                outcome.toString()
            },
            false
          )
        }
      }

      if (me.CHEAT_dontack) {
        l('CHEAT: not acking the secret, but pulling from inward')
        ch.d.status = 'CHEAT_dontack'
        await ch.d.save()
        react({private: true}) // lazy react
        return
      }
    }
  }

  //refresh(ch)

  // since we applied partner's diffs, all we need is to add the diff of our own transitions
  if (ch.d.rollback_nonce > 0) {
    // merging and leaving rollback mode
    ch.d.dispute_nonce += ch.d.rollback_nonce
    ch.d.rollback_nonce = 0

    ch.d.subchannels.map((subch) => {
      subch.offdelta += subch.rollback_offdelta
      subch.rollback_offdelta = 0
    })

    refresh(ch)

    if (trace) l(`After merge our state is \n${ascii_state(ch.state)}`)

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
  if (
    (ch.d.isLeft() && ch.d.offdelta > o) ||
    (!ch.d.isLeft() && ch.d.offdelta < o)
  ) {
    ch.d.CHEAT_profitable_state = ch.d.signed_state
    ch.d.CHEAT_profitable_sig = ch.d.sig
  }
  */

  //if (argv.syncdb) {
  //all.push(ch.d.save())

  //await syncdb() //Promise.all(all)
  //}

  return flushable

  // If no transitions received, do opportunistic flush, otherwise give forced ack
}
