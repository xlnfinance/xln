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
  return q([pubkey, asset], async () => {
    //loff(`--- Flush ${trim(pubkey)} ${opportunistic}`)

    let ch = await me.getChannel(pubkey, asset)

    let flushable = []
    let all = []

    if (ch.d.status == 'sent') {
      //loff(`=== End flush ${trim(pubkey)} CANT`)

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
    let debugState = r(r(ch.state))

    // array of actions to apply to canonical state
    var transitions = []

    // merge cannot add new transitions because expects another ack
    // in merge mode all you do is ack last (merged) state
    if (ch.d.status == 'master') {
      // hub waits a bit in case destination returns secret quickly
      if (me.my_hub && !opportunistic) await sleep(50)

      for (var t of ch.payments) {
        if (t.status != 'new') continue

        if (t.type == 'del') {
          /*
          if (me.CHEAT_dontreveal) {
            loff('CHEAT: not revealing our secret to inward')
            continue
          }*/

          // the beginning is same for both transitions
          /*
          let hl = remove(ch.inwards, t.hash)

          if (!hl) {
            loff('error No such hashlock')
            continue
          }
          */

          if (t.secret && t.secret.length == K.secret_len) {
            ch.d.offdelta += ch.left ? t.amount : -t.amount
          }
          var args = [t.hash, t.secret]
          /*
        } else if (t.type == 'delrisk') {
          if (t.secret) {
            ch.d.offdelta += ch.left ? -t.amount : t.amount
          }
          args = [t.hash, t.secret]*/
        } else if (t.type == 'add' || t.type == 'addrisk') {
          /*
          if (
            t.lazy_until &&
            t.lazy_until > new Date() &&
            ch.payable - ch.insurance < t.amount
          ) {
            l('Still lazy, wait')
            continue
          }*/

          if (
            t.amount < K.min_amount ||
            t.amount > K.max_amount ||
            t.amount > ch.payable ||
            t.destination.equals(me.pubkey) ||
            ch.outwards.length >= K.max_hashlocks
          ) {
            loff(
              `error cannot transit ${t.amount}/${ch.payable}. Locks ${
                ch.outwards.length
              }.`
            )

            me.metrics.fail.current++

            t.type = 'del'
            t.status = 'ack'

            if (argv.syncdb) all.push(t.save())

            if (t.inward_pubkey) {
              var inward = await me.getChannel(t.inward_pubkey, ch.d.asset)
              var pull_hl = inward.inwards.find((hl) => hl.hash.equals(t.hash))
              pull_hl.type = 'del'
              pull_hl.status = 'new'
              if (argv.syncdb) all.push(pull_hl.save())

              flushable.push(inward.d.partnerId)
            }

            continue
          }
          if (ch.outwards.length >= K.max_hashlocks) {
            loff('error Cannot set so many hashlocks now, try later')
            //continue
          }
          /*
          if (t.type == 'add') {
            // add hashlock to canonical state
            ch.outwards.push(t)
          } else {
            // store hashlock off-state as "verbal agreement"
            ch.d.offdelta += ch.left ? -t.amount : t.amount
          }*/

          //l('Hash sent ' + toHex(t.hash))

          args = [t.amount, t.hash, t.exp, t.destination, t.unlocker]
        }

        t.status = 'sent'
        if (argv.syncdb) all.push(t.save())

        // increment nonce after each transition
        ch.d.nonce++

        transitions.push([
          methodMap(t.type),
          args,
          ec(r(refresh(ch)), me.id.secretKey)
        ])
      }

      if (opportunistic && transitions.length == 0) {
        //loff(`=== End flush ${trim(pubkey)}: Nothing to flush`)
        return
      }
    } else if (ch.d.status == 'merge') {
      //loff('In merge, no tr')
      // important trick: only merge flush once to avoid bombing with equal acks
      if (opportunistic) return
    }

    // transitions: method, args, sig, new state
    let envelope = me.envelope(
      methodMap('update'),
      asset,
      ackSig,
      transitions,
      debugState, // state we started with
      r(ch.d.signed_state) // signed state we started with
    )

    if (transitions.length > 0) {
      ch.d.ack_requested_at = new Date()
      //ch.d.pending = envelope
      ch.d.status = 'sent'
      loff(
        `=== End flush ${transitions.length} (${envelope.length}) to ${trim(
          pubkey
        )}`
      )
    }

    if (argv.syncdb) {
      all.push(ch.d.save())
      await Promise.all(all)
    }

    me.send(ch.d.partnerId, 'update', envelope)

    return Promise.all(flushable.map((fl) => me.flushChannel(fl, asset, true)))
  })
}
