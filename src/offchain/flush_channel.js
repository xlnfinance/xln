// Flush all pending transitions to state channel. Types:
/*
Payment lifecycles:
outward payments: add > (we just added) > added (it is in canonical state) > settled or failed
inward payments: added > (we received it with transitions) > settle/fail (pending) > settled/failed

add - add outward hashlock
settle - unlock inward hashlock by providing secret
fail - delete inward hashlock for some reason
*/

module.exports = async (ch, force_flush = false) => {
  //await sleep(2000)

  // First, we add a transition to the queue

  if (ch.d.status == 'sent') {
    //l(`Can't flush, awaiting ack.`)
    //me.send(partner, 'update', ch.d.pending)
    return false
  }

  var newState = await ch.d.getState()
  var ackSig = ec(r(newState), me.id.secretKey)
  var debugState = r(r(newState))

  // array of actions to apply to canonical state
  var transitions = []

  // rollback cannot add new transitions because expects another ack
  // in rollback mode all you do is ack last (merged) state
  if (ch.d.status != 'merge') {
    var inwards = newState[ch.left ? 2 : 3]
    var payable = ch.payable

    var pendings = await ch.d.getPayments({
      where: {
        status: {[Sequelize.Op.or]: ['add', 'settle', 'fail']}
      }
    })

    for (var t of pendings) {
      if (t.status == 'settle' || t.status == 'fail') {
        if (me.handicap_dontreveal) {
          l('HANDICAP ON: not revealing our secret to inward')
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

        if (t.status == 'settle') {
          newState[1][3] += ch.left ? t.amount : -t.amount
          payable += t.amount
          var args = t.secret
        } else {
          var args = t.hash
        }
      } else if (t.status == 'add') {
        // todo: this might be not needed as previous checks are sufficient
        if (
          t.amount < 0 ||
          t.amount > payable ||
          t.destination.equals(me.pubkey)
        ) {
          l('error cannot transit this amount. Failing inward.')
          var inward = await t.getInward()

          if (inward) {
            inward.status = 'fail'
            await inward.save()
            var notify = await me.getChannel(inward.deltum.partnerId)
            await notify.d.requestFlush()
          }
          t.status = 'fail_sent'
          await t.save()

          continue
        }
        // decrease payable and add the hashlock to state
        payable -= t.amount
        newState[ch.left ? 3 : 2].push(t.toLock())

        var args = [t.amount, t.hash, t.exp, t.destination, t.unlocker]
      }
      // increment nonce after each transition
      newState[1][2]++

      transitions.push([
        methodMap(t.status),
        args,
        ec(r(newState), me.id.secretKey)
      ])

      t.status += '_sent'
      await t.save()
    }

    if (transitions.length == 0) {
      if (!force_flush) {
        return //l('No transitions to flush')
      }
    } else {
      ch.d.status = 'sent'
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
    ch.d.pending = envelope
  }

  await ch.d.save()

  react()

  if (!me.send(ch.d.partnerId, 'update', envelope)) {
    //l(`${partner} not online, deliver later?`)
  }
}
