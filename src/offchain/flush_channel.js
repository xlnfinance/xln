// Flush all new transitions to state channel. Types:
/*
Payment lifecycles:
outward payments: addnew > addsent > addack > delack
inward payments: addack > delnew > delsent > delack

add - add outward hashlock
del - remove inward hashlock by providing secret or reason of failure

This module has 3 types of behavior:
regular flush: flushes ack with or without transitions
opportunistic flush: flushes only if there are any transitions (used after receiving empty ack response)
during merge: no transitions can be applied, otherwise deadlock could happen.

Always flush opportunistically, unless you are acking your direct partner who sent tx to you.
*/

module.exports = async (pubkey, asset, opportunistic) => {
  await section(['use', pubkey, asset], async () => {
    if (trace) l(`Started Flush ${trim(pubkey)} ${opportunistic}`)

    let ch = await me.getChannel(pubkey, asset)
    ch.last_used = ts()

    let flushable = []
    let all = []

    if (ch.d.status == 'sent') {
      if (trace) l(`End flush ${trim(pubkey)}, in sent`)

      if (ch.d.ack_requested_at < new Date() - 4000) {
        //me.send(ch.d.partnerId, 'update', ch.d.pending)
      }
      return
    }

    if (ch.d.status == 'CHEAT_dontack') {
      return
    }

    if (ch.d.status == 'disputed') {
      return
    }

    let ackSig = ec(r(refresh(ch)), me.id.secretKey)
    let initialState = r(r(ch.state))

    // array of actions to apply to canonical state
    var transitions = []

    // merge cannot add new transitions because expects another ack
    // in merge mode all you do is ack last (merged) state
    if (ch.d.status == 'master') {
      // hub waits a bit in case destination returns secret quickly
      if (me.my_hub && !opportunistic) await sleep(150)

      for (var t of ch.payments) {
        if (t.status != 'new') continue

        if (t.type == 'del') {
          // remove a hashlock and provide either secret or reason of failure
          if (me.CHEAT_dontreveal) {
            loff('CHEAT: not revealing our secret to inward')
            continue
          }

          if (t.outcome_type == methodMap('outcomeSecret')) {
            ch.d.offdelta += ch.left ? t.amount : -t.amount
          }
          var args = [t.hash, t.outcome_type, t.outcome]
        } else if (t.type == 'delrisk') {
          // works like refund
          //if (!t.secret) {
          ch.d.offdelta += ch.left ? -t.amount : t.amount
          //}

          //var args = [t.hash, t.secret]
        } else if (t.type == 'add' || t.type == 'addrisk') {
          if (
            t.lazy_until &&
            t.lazy_until > new Date() &&
            ch.payable - ch.ins.insurance < t.amount
          ) {
            l('Still lazy, wait')
            continue
          }

          if (
            t.amount < K.min_amount ||
            t.amount > K.max_amount ||
            t.amount > ch.payable ||
            ch.outwards.length >= K.max_hashlocks
          ) {
            loff(
              `error cannot transit ${t.amount}/${ch.payable}. Locks ${
                ch.outwards.length
              }.`
            )

            if (me.my_hub && t.amount > ch.payable) {
              me.textMessage(
                ch.d.partnerId,
                `Cant send ${t.amount} payable ${ch.payable}, extend credit`
              )
            }

            me.metrics.fail.current++

            t.type = 'del'
            t.status = 'ack'
            //if (argv.syncdb) all.push(t.save())

            if (t.inward_pubkey) {
              var inward = await me.getChannel(t.inward_pubkey, ch.d.asset)
              var pull_hl = inward.inwards.find((hl) => hl.hash.equals(t.hash))
              pull_hl.type = 'del'
              pull_hl.status = 'new'
              let reason = `${me.my_hub.id} to ${ch.hub ? ch.hub.id : 'u'}`
              l(reason)

              pull_hl.outcome_type = methodMap('outcomeCapacity')
              pull_hl.outcome = bin(reason)
              //if (argv.syncdb) all.push(pull_hl.save())

              flushable.push(inward.d.partnerId)
            }

            continue
          }
          if (ch.outwards.length >= K.max_hashlocks) {
            loff('error Cannot set so many hashlocks now, try later')
            //continue
          }

          // set exp right before flushing to keep it fresh
          ;(t.exp = K.usable_blocks + K.hashlock_exp),
            (args = [t.amount, t.hash, t.exp, t.unlocker])
        }

        t.status = 'sent'
        //if (argv.syncdb) all.push(t.save())

        // increment nonce after each transition
        ch.d.nonce++

        transitions.push([
          methodMap(t.type),
          args,
          ec(r(refresh(ch)), me.id.secretKey)
        ])

        if (trace)
          l(
            `Adding a new ${t.type}, resulting state: \n${ascii_state(
              ch.state
            )}`
          )
      }

      if (opportunistic && transitions.length == 0) {
        if (trace) l(`End flush ${trim(pubkey)}: Nothing to flush`)
        return
      }
    } else if (ch.d.status == 'merge') {
      // important trick: only merge flush once to avoid bombing with equal acks
      if (opportunistic) return

      if (trace) l('In merge, no transactions can be added')
    }

    //only for debug, can be heavy
    var debug = [
      initialState, // state we started with
      ch.state, // state we finished at
      r(ch.d.signed_state) // signed state we have
    ]

    // transitions: method, args, sig, new state
    let envelope = me.envelope(
      methodMap('update'),
      asset,
      ackSig,
      transitions,
      debug
    )

    if (transitions.length > 0) {
      // if there were any transitions, we need an ack on top
      ch.d.ack_requested_at = new Date()
      //l('Set ack request ', ch.d.ack_requested_at, trim(pubkey))
      //ch.d.pending = envelope
      ch.d.status = 'sent'
      if (trace)
        l(
          `Flushing ${transitions.length} (${envelope.length}b) to ${trim(
            pubkey
          )}`
        )
    }

    me.send(ch.d.partnerId, 'update', envelope)

    return Promise.all(flushable.map((fl) => me.flushChannel(fl, asset, true)))
  })
}
