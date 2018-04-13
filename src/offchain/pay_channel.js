// add a transition to state channel
module.exports = async (opts) => {
  var ch = await me.getChannel(opts.partner)

  if (ch.d.status != 'ready') {
    return [false, 'The channel is not ready to accept payments: ' + ch.d.status]
  }

  var t = await ch.d.createTransition({
    hash: opts.hash,
    offdelta: ch.left ? -opts.amount : opts.amount,
    exp: K.usable_blocks + 10,
    mediate_to: opts.mediate_to,
    unlocker: opts.unlocker ? opts.unlocker : false,
    status: 'await'
  })

  /*
  var list = await ch.d.getTransitions({where: [Sequelize.Op.or]: [
    {status: 'await'},
    {status: 'acked'}
    ]
  })
  */
  
  ch.d.status = 'await'

  var transitions = []
  var newState = await ch.d.getState()

  var list = await ch.d.getTransitions({where:{status: 'await'}})


  var payable = ch.payable

  for (var t of list) {
    // is valid transition right now?
    var amount = ch.left ? -t.offdelta : t.offdelta

    if (amount < 0 || amount > payable) {
      l("wrong amount")
      continue
    }

    payable -= amount

    newState[3]++ //nonce


    l('transfer ', ch.left, t.offdelta)
    // add hashlocks


    newState[5].push([t.offdelta, t.hash, t.exp])


    var state = r(newState)
    transitions.push([
      methodMap(t.unlocker ? 'addlock' : 'add'),
      [
        t.offdelta, 
        t.hash, 
        t.exp,
        t.mediate_to,
        t.unlocker
      ],
      ec(state, me.id.secretKey), 
      state // debug only
    ])

  }

  if (transitions.length == 0) return l("No transitions")

  ch.d.nonce = newState[3]
  await ch.d.save()


  // what do we do when we get the secret
  if (opts.return_to) purchases[toHex(opts.invoice)] = opts.return_to


  l("Sending an update to ", opts.partner, transitions)

  // transitions: method, args, sig, new state
  var envelope = me.envelope(methodMap('update'), transitions)

  if (!me.send(opts.partner, 'update', envelope)) {
    //l(`${opts.partner} not online, deliver later?`)
  }

  return [true, false]
}


/*
// todo:

  if (opts.amount < K.min_amount || opts.amount > Math.min(ch.payable, K.max_amount)) {
    return [false, `The amount must be between $${commy(K.min_amount)} and $${commy(K.max_amount)}`]
  }



  if (me.my_hub) {
    //l('todo: ensure delivery')
  } else {
    await me.addHistory(opts.partner, -opts.amount, 'Sent to ' + opts.mediate_to.toString('hex').substr(0, 10) + '..', true)
  }
*/