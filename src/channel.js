module.exports = async payChannel (opts) {
  var ch = await me.channel(opts.partner)

  if (ch.d.status != 'ready') {
    return [false, 'The channel is not ready to accept payments: ' + ch.d.status]
  }


  if (opts.amount < K.min_amount || opts.amount > Math.min(ch.payable, K.max_amount)) {
    return [false, `The amount must be between $${commy(K.min_amount)} and $${commy(K.max_amount)}`]
  }

  await ch.d.createTransition({
    hash: opts.invoice,
    offdelta: ch.left ? -opts.amount : opts.amount,
    unlocker: opts.mediate_to,
    status: 'await'
  })

  var list = await ch.d.getTransitions({where: {status: 'await'}})
  for (var t of list) {

  }

  ch.d.offdelta += ch.left ? -opts.amount : opts.amount

  ch.d.nonce++


  var newState = ch.d.getState()

  var body = r([
    methodMap('update'),
    // transitions
    [[methodMap('unlockedPayment'), opts.amount, opts.invoice, opts.mediate_hub, opts.mediate_to]],
    // sign final state
    ec(newState, me.id.secretKey),
    // share our state for debug
    newState
  ])

  var signedState = r([
    me.pubkey,
    ec(body, me.id.secretKey),
    body
  ])

  ch.d.status = 'await'

  await ch.d.save()

  if (me.is_hub) {
    //l('todo: ensure delivery')
  } else {
    await me.addHistory(opts.partner, -opts.amount, 'Sent to ' + opts.mediate_to.toString('hex').substr(0, 10) + '..', true)
  }

  // what do we do when we get the secret
  if (opts.return_to) purchases[toHex(opts.invoice)] = opts.return_to

  if (!me.send(opts.partner, 'update', signedState)) {
    //l(`${opts.partner} not online, deliver later?`)
  }

  return [true, false]
}