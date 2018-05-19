// Flush all new transitions to state channel. Types:
/*
Payment lifecycles:
outward payments: add/new > (we just added) > add/sent > add/acked > settle or fail/acked
inward payments: add/acked > (we received it with transitions) > settle or fail/new > sent > acked

add - add outward hashlock
settle - unlock inward hashlock by providing secret
fail - delete inward hashlock for some reason.

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
    refresh(ch)

    let flushable = []
    let all = []

    // First, we add a transition to the queue

    if (ch.d.status == 'CHEAT_dontack') {
      return
    }

    if (ch.d.status == 'disputed') {
      return
    }

    if (ch.d.status == 'sent') {
      //loff(`=== End flush ${trim(pubkey)} CANT`)

      if (ch.d.ack_requested_at < new Date() - 4000) {
        //me.send(ch.d.partnerId, 'update', ch.d.pending)
      }
      return
    }

    let ackSig = ec(r(refresh(ch)), me.id.secretKey)
    let debugState = r(r(ch.state))

    // array of actions to apply to canonical state
    let transitions = []

    // merge cannot add new transitions because expects another ack
    // in merge mode all you do is ack last (merged) state
    if (ch.d.status == 'master') {
      for (let t of ch.payments) {
        if (t.status != 'new') continue

        // what arguments this transition has
        let args = []
        if (t.type == 'settle' || t.type == 'fail') {
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

          if (t.type == 'settle') {
            ch.d.offdelta += ch.left ? t.amount : -t.amount
            args = t.secret
          } else {
            args = t.hash
          }
          /*
        } else if (t.type == 'settlerisk' || t.type == 'failrisk') {
          if (t.type == 'failrisk') {
            ch.d.offdelta += ch.left ? -t.amount : t.amount
            args = t.hash
          } else {
            args = t.secret
          }*/
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

            t.type = t.type == 'add' ? 'fail' : 'failrisk'
            t.status = 'acked'
            all.push(t.save())

            if (t.inward_pubkey) {
              var inward = await me.getChannel(t.inward_pubkey, ch.d.asset)
              var hl = inward.inwards.find((hl) => hl.hash.equals(t.hash))
              hl.type = t.type == 'add' ? 'fail' : 'failrisk'
              all.push(hl.save())

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

          args = [t.amount, t.hash, t.exp, t.destination, t.unlocker]
        }

        t.status = 'sent'
        all.push(t.save())

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
      ch.d.pending = envelope
      ch.d.status = 'sent'
    }

    all.push(ch.d.save())
    await Promise.all(all)
    me.send(ch.d.partnerId, 'update', envelope)

    //loff(`=== End flush ${transitions.length} tr to ${trim(pubkey)}`)
    return Promise.all(flushable.map((fl) => me.flushChannel(fl, asset, true)))
  })
}
