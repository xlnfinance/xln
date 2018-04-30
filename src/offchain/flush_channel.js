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

module.exports = async (ch, opportunistic = false) => {
  var _ = await lock(toHex(ch.d.partnerId))

  var ch = await me.getChannel(ch.d.partnerId)

  // First, we add a transition to the queue

  if (ch.d.status == 'CHEAT_dontack') {
    return _()
  }

  if (ch.d.status == 'disputed') {
    return _()
  }

  if (ch.d.status == 'sent') {
    if (ch.d.ack_requested_at < new Date() - 30000) {
      l(`Can't flush, awaiting ack. Repeating our request?`)
      //me.send(ch.d.partnerId, 'update', ch.d.pending)
    }
    return _()
  }

  var newState = await ch.d.getState()
  var ackSig = ec(r(newState), me.id.secretKey)
  var debugState = r(r(newState))

  // array of actions to apply to canonical state
  var transitions = []

  // merge cannot add new transitions because expects another ack
  // in merge mode all you do is ack last (merged) state
  if (ch.d.status == 'master') {
    var inwards = newState[ch.left ? 2 : 3]
    var outwards = newState[ch.left ? 3 : 2]
    var payable = ch.payable

    var pendings = await ch.d.getPayments({
      where: {
        status: 'new'
      }
    })

    for (var t of pendings) {
      if (t.type == 'settle' || t.type == 'fail') {
        if (me.CHEAT_dontreveal) {
          l('CHEAT: not revealing our secret to inward')
          continue
        }

        // the beginning is same for both transitions
        var index = inwards.findIndex((hl) => hl[1].equals(t.hash))
        var hl = inwards[index]

        if (!hl) {
          l('No such hashlock')
          continue
        }

        inwards.splice(index, 1)

        if (t.type == 'settle') {
          newState[1][3] += ch.left ? t.amount : -t.amount
          payable += t.amount
          var args = t.secret
        } else {
          var args = t.hash
        }
      } else if (t.type == 'add') {
        // todo: this might be not needed as previous checks are sufficient
        if (
          t.amount < K.min_amount ||
          t.amount > payable ||
          t.destination.equals(me.pubkey) ||
          outwards.length >= K.max_hashlocks
        ) {
          l('error cannot transit this amount. Failing inward.')
          var inward = await t.getInward()

          if (inward) {
            inward.type = 'fail'
            await inward.save()
            await me.flushChannel(inward.deltum.partnerId)
            //var notify = await me.getChannel(inward.deltum.partnerId)
            //await notify.d.requestFlush()
          }
          t.type = 'fail'
          t.status = 'acked'
          await t.save()

          continue
        }
        if (outwards.length >= K.max_hashlocks) {
          l('Cannot set so many hashlocks now, maybe later')
          //continue
        }
        // decrease payable and add the hashlock to state
        payable -= t.amount
        outwards.push(t.toLock())

        var args = [t.amount, t.hash, t.exp, t.destination, t.unlocker]
      }
      // increment nonce after each transition
      newState[1][2]++

      transitions.push([
        methodMap(t.type),
        args,
        ec(r(newState), me.id.secretKey)
      ])

      t.status = 'sent'
      await t.save()
    }

    if (opportunistic && transitions.length == 0) {
      return _() //l('Nothing to flush')
    }
  }

  // transitions: method, args, sig, new state
  var envelope = me.envelope(
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

  await ch.d.save()

  if (!me.send(ch.d.partnerId, 'update', envelope)) {
    //l(`${partner} not online, deliver later?`)
  }

  return _()
}
