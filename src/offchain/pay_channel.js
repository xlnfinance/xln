// Flush all pending transitions to state channel. Types:
/*
// 10,[] => 15,[] - add directly to base offdelta
'add',

// 15,[] => 15,[] - (NOT STATE CHANGING) offdelta remains the same, there was no hashlock
'settle',

// 15,[] => 10,[] - secret not found, offdelta is decreased voluntarily 
'fail',
 
// 10,[] => 10,[[5,H1,E1]]
'addlock', // we add hashlock transfer to state. 

// 10,[[5,H1,E1]] => 15,[]
'settlelock', // we've got the secret so please unlock and apply to base offdelta

// 10,[[5,H1,E1]] => 10,[]
'faillock', // couldn't get secret for <reason>, delete hashlock
*/

module.exports = async (partner, force_flush = false) => {
  // First, we add a transition to the queue
  var ch = await me.getChannel(partner)

  // If channel is master, send transitions now. Otherwise wait for ack

  if (ch.d.status == 'sent') {
    return l('Still waiting for ack')
  }

  if (ch.d.status == 'listener' && !force_flush) {
    me.send(partner, 'update', me.envelope(methodMap('requestMaster')))
    return l('Try to obtain master...')
  }

  if (ch.d.status == 'master') {
    l('Flushing changes')
  }

  var newState = await ch.d.getState()

  var transitions = []

  l('Current state to be acked ', newState)

  var ackSig = ec(r(newState), me.id.secretKey)

  var unlockable = await ch.d.getPayments({
    where: {is_inward: true, status: 'unlocking'}
  })
  for (var t of unlockable) {
    var inwards = newState[ch.left ? 5 : 6]

    for (var i in inwards) {
      if (inwards[i][1].equals(t.hash)) {
        l('Removing hashlock from state and applying')
        inwards.splice(i, 1)

        newState[4] += ch.left ? t.amount : -t.amount
        break
      }
    }
    newState[3]++

    t.status = 'unlocked'
    await t.save()

    var signable = r(newState)
    transitions.push([
      methodMap('settlelock'),
      t.secret,
      ec(signable, me.id.secretKey),
      signable // debug only
    ])
  }

  var outgoing = await ch.d.getPayments({
    where: {is_inward: false, status: 'await'}
  })
  var payable = ch.payable

  for (var t of outgoing) {
    if (t.amount < 0 || t.amount > payable) {
      l('Invalid transition amount')
      continue
    }

    if (t.destination.equals(me.pubkey)) {
      l('Cannot pay to self')
      continue
    }
    payable -= t.amount

    newState[3]++ //nonce

    // add hashlocks

    newState[ch.left ? 6 : 5].push(t.toLock())

    var signable = r(newState)
    transitions.push([
      // use hashlocks for $100+ payments
      methodMap('addlock'),
      [t.amount, t.hash, t.exp, t.destination, t.unlocker],
      ec(signable, me.id.secretKey),
      signable // debug only
    ])
    t.status = 'hashlock'
    await t.save()
  }

  if (transitions.length == 0) {
    if (!force_flush) {
      return l('No transitions to flush')
    }
  } else {
    ch.d.status = 'sent'
  }

  // transitions: method, args, sig, new state
  var envelope = me.envelope(methodMap('update'), ackSig, transitions)

  ch.d.nonce = newState[3]
  ch.d.offdelta = newState[4]

  ch.d.pending = envelope

  await ch.d.save()

  react()

  if (!me.send(partner, 'update', envelope)) {
    //l(`${partner} not online, deliver later?`)
  }
}

/*
// todo:

  if (opts.amount < K.min_amount || opts.amount > Math.min(ch.payable, K.max_amount)) {
    return [false, `The amount must be between $${commy(K.min_amount)} and $${commy(K.max_amount)}`]
  }



  if (me.my_hub) {
    //l('todo: ensure delivery')
  } else {
    await me.addHistory(opts.partner, -opts.amount, 'Sent to ' + opts.destination.toString('hex').substr(0, 10) + '..', true)
  }
*/
