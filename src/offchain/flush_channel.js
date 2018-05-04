// Flush all pending transitions to state channel. Types:
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
during merge: no transitions can be applied, otherwise deadlock could happen
*/

module.exports = async (pubkey, opportunistic = false) => {
  let _ = await lock(pubkey)
  loff(
    `--- Start flush ${trim(pubkey)} ${opportunistic ? 'opportunistic' : ''}`
  )
  //let _ = () => {}

  let ch = await me.getChannel(pubkey)
  let flushable = []
  let all = []

  // First, we add a transition to the queue

  if (ch.d.status == 'CHEAT_dontack') {
    return _()
  }

  if (ch.d.status == 'disputed') {
    return _()
  }

  if (ch.d.status == 'sent') {
    loff(
      `=== End flush ${trim(
        pubkey
      )} CANT flush, awaiting ack. Repeating our request?`
    )

    if (ch.d.ack_requested_at < new Date() - 10000) {
      //me.send(ch.d.partnerId, 'update', ch.d.pending)
    }
    return _()
  }

  let newState = await ch.d.getState()
  let ackSig = ec(r(newState), me.id.secretKey)
  let debugState = r(r(newState))

  // array of actions to apply to canonical state
  let transitions = []

  // merge cannot add new transitions because expects another ack
  // in merge mode all you do is ack last (merged) state
  if (ch.d.status == 'master') {
    let inwards = newState[ch.left ? 2 : 3]
    let outwards = newState[ch.left ? 3 : 2]
    let payable = ch.payable

    let pendings = await ch.d.getPayments({
      where: {
        status: 'new'
      }
    })

    for (let t of pendings) {
      // what arguments this transition has
      let args = []
      if (t.type == 'settle' || t.type == 'fail') {
        if (me.CHEAT_dontreveal) {
          loff('CHEAT: not revealing our secret to inward')
          continue
        }

        // the beginning is same for both transitions
        let index = inwards.findIndex((hl) => hl[1].equals(t.hash))
        let hl = inwards[index]

        if (!hl) {
          loff('No such hashlock')
          continue
        }

        inwards.splice(index, 1)

        if (t.type == 'settle') {
          newState[1][3] += ch.left ? t.amount : -t.amount
          payable += t.amount
          args = t.secret
        } else {
          args = t.hash
        }
      } else if (t.type == 'add') {
        // todo: this might be not needed as previous checks are sufficient
        if (
          t.amount < K.min_amount ||
          t.amount > K.max_amount ||
          t.amount > payable ||
          t.destination.equals(me.pubkey) ||
          outwards.length >= K.max_hashlocks
        ) {
          loff('error cannot transit this amount. Failing inward.')
          let inward = await t.getInward()

          if (inward) {
            inward.type = 'fail'
            all.push(inward.save())
            flushable.push(inward.deltum.partnerId)
            //let notify = await me.getChannel(inward.deltum.partnerId)
            //await notify.d.requestFlush()
          }
          t.type = 'fail'
          t.status = 'acked'
          all.push(t.save())

          continue
        }
        if (outwards.length >= K.max_hashlocks) {
          loff('Cannot set so many hashlocks now, try later')
          //continue
        }
        // decrease payable and add the hashlock to state
        payable -= t.amount
        outwards.push(t.toLock())

        args = [t.amount, t.hash, t.exp, t.destination, t.unlocker]
      }
      // increment nonce after each transition
      newState[1][2]++

      transitions.push([
        methodMap(t.type),
        args,
        ec(r(newState), me.id.secretKey)
      ])

      t.status = 'sent'
      all.push(t.save())
    }

    if (opportunistic && transitions.length == 0) {
      loff(`=== End flush ${trim(pubkey)}: Nothing to flush`)
      _()
      return
    }
  }

  // transitions: method, args, sig, new state
  let envelope = me.envelope(
    methodMap('update'),
    ackSig,
    transitions,
    debugState, // our current state
    r(ch.d.signed_state) // our last signed state
  )

  ch.d.nonce = newState[1][2]
  ch.d.offdelta = newState[1][3]

  if (transitions.length > 0) {
    ch.d.ack_requested_at = new Date()
    ch.d.pending = envelope
    ch.d.status = 'sent'
  }

  all.push(ch.d.save())

  loff(`=== End flush ${transitions.length} tr to ${trim(pubkey)}`)

  Promise.all(all).then(() => {
    _()
  })

  if (!me.send(ch.d.partnerId, 'update', envelope)) {
    //l(`${partner} not online, deliver later?`)
  }

  flushable.map((fl) => me.flushChannel(fl))
}
