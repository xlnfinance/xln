// Flush all pending transitions to state channel. Types:
/*
Payment lifecycles:
outward payments: add > (we just added) > added (it is in canonical state) > settled or failed
inward payments: added > (we received it with transitions) > settle/fail (pending) > settled/failed

addlock - add outward hashlock
settlelock - unlock inward hashlock by providing secret
faillock - delete inward hashlock for some reason
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

  // set of actions to apply to canonical state
  var transitions = []

  // rollback cannot add new transitions because expects another ack
  // in rollback mode all you do is ack last (merged) state
  if (ch.d.status != 'merge') {
    var inwards = newState[ch.left ? 2 : 3]
    var payable = ch.payable

    var to_settle = await ch.d.getPayments({
      where: {is_inward: true, status: 'settle'}
    })
    for (var t of to_settle) {
      if (me.handicap_dontreveal) {
        l('HANDICAP ON: not revealing our secret to inward')
        continue
      }

      var index = inwards.findIndex((hl) => hl[1].equals(t.hash))
      var hl = inwards[index]

      if (!hl) {
        l('No such hashlock')
        break
      }
      inwards.splice(index, 1)
      newState[1][3] += ch.left ? t.amount : -t.amount
      newState[1][2]++

      payable += t.amount

      t.status = 'settled'
      await t.save()

      transitions.push([
        methodMap('settlelock'),
        t.secret,
        ec(r(newState), me.id.secretKey)
      ])
    }

    var to_fail = await ch.d.getPayments({
      where: {is_inward: true, status: 'fail'}
    })
    for (var t of to_fail) {
      var index = inwards.findIndex((hl) => hl[1].equals(t.hash))
      var hl = inwards[index]

      if (!hl) {
        l('No such hashlock')
        break
      }
      inwards.splice(index, 1)
      newState[1][2]++

      t.status = 'failed'
      await t.save()

      transitions.push([
        methodMap('faillock'),
        t.hash,
        ec(r(newState), me.id.secretKey)
      ])
    }

    var to_add = await ch.d.getPayments({
      where: {is_inward: false, status: 'add'}
    })

    for (var t of to_add) {
      if (
        t.amount < 0 ||
        t.amount > payable ||
        t.destination.equals(me.pubkey)
      ) {
        l('error Invalid transition amount')
        var inward = await t.getInward()

        if (inward) {
          inward.status = 'fail'
          await inward.save()
          var notify = await me.getChannel(inward.deltum.partnerId)
          await notify.d.requestFlush()
        }
        t.status = 'failed'
        await t.save()

        continue
      }

      payable -= t.amount

      newState[1][2]++ //nonce

      // add hashlocks

      newState[ch.left ? 3 : 2].push(t.toLock())

      transitions.push([
        methodMap('addlock'),
        [t.amount, t.hash, t.exp, t.destination, t.unlocker],
        ec(r(newState), me.id.secretKey)
      ])
      t.status = 'added'
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

  // If channel is master, send transitions now. Otherwise wait for ack
  //l(`Sending ${ch.partner} - Tr ${transitions.length}`)

  if (!me.send(ch.d.partnerId, 'update', envelope)) {
    //l(`${partner} not online, deliver later?`)
  }
}
