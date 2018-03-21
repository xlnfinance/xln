module.exports = async (opts) => {
  var ch = await me.channel(opts.partner)

  if (ch.d.status != 'ready') {
    return [false, 'The channel is not ready to accept payments: ' + ch.d.status]
  }

  l(chalk.blue("Adding a transition"))

  await ch.d.createTransition({
    hash: opts.invoice,
    offdelta: ch.left ? -opts.amount : opts.amount,
    exp: K.usable_blocks + 10,
    unlocker: opts.mediate_to,
    status: 'await'
  })

  /*

  var list = await ch.d.getTransitions({where: [Sequelize.Op.or]: [
    {status: 'await'},
    {status: 'acked'}
    ]
  })
  */
  var compared = Buffer.compare(ch.d.myId, ch.d.partnerId)

  var transitions = []

  var newState = [methodMap('offdelta'),
    compared==-1?ch.d.myId:ch.d.partnerId,
    compared==-1?ch.d.partnerId:ch.d.myId,
    ch.d.nonce++,
    packSInt(ch.d.offdelta),
    (await ch.d.getTransitions({where: {status: 'hashlock'}})).map(
      t=>[packSInt(t.offdelta), t.hash, t.exp]
      ) 
  ]

  l(chalk.red(newState))


  var list = await ch.d.getTransitions({where:{status: 'await'}})
  var payable = ch.payable

  for (var t of list) {
    // is valid transition right now?
    if (t.offdelta > payable) continue

    payable -= t.offdelta

    // has not been acked yet
    transitions.push([methodMap('addHashlock'), 
      t.offdelta, 
      t.hash, 
      t.exp,
      t.unlocker
    ])
    // add hashlocks
    newState[5].push([packSInt(t.offdelta), t.hash, t.exp])
  }


  newState = r(newState)

  var body = r([
    methodMap('update'),
    transitions,
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


  // what do we do when we get the secret
  if (opts.return_to) purchases[toHex(opts.invoice)] = opts.return_to

  if (!me.send(opts.partner, 'update', signedState)) {
    //l(`${opts.partner} not online, deliver later?`)
  }

  return [true, false]
}


/*
// todo:

  if (opts.amount < K.min_amount || opts.amount > Math.min(ch.payable, K.max_amount)) {
    return [false, `The amount must be between $${commy(K.min_amount)} and $${commy(K.max_amount)}`]
  }



  if (me.is_hub) {
    //l('todo: ensure delivery')
  } else {
    await me.addHistory(opts.partner, -opts.amount, 'Sent to ' + opts.mediate_to.toString('hex').substr(0, 10) + '..', true)
  }
*/