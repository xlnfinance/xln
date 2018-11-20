// Fairlayer runs e2e tests on itself,
// different nodes acting like "monkeys" and doing different overlapping scenarios

const payMonkey = async (on_server, counter = 1) => {
  const address = monkeys.randomElement()
  // offchain payment
  await me.payChannel({
    address: address,
    amount: 100 + Math.round(Math.random() * 20000),
    asset: 1
  })

  const [_, pubkey] = r(base58.decode(address))
  const reg = await getUserByIdOrKey(pubkey)

  // onchain payment (batched, not sent to validator yet)
  me.batchAdd('depositTo', [
    1,
    [Math.round(Math.random() * 1000), reg.id ? reg.id : pubkey, 0]
  ])

  // run on server infinitely and with longer delays
  // but for local tests limit requests and run faster
  if (on_server) {
    // replenish with testnet faucet once in a while

    setTimeout(() => {
      payMonkey(on_server, counter + 1)
    }, Math.round(3500 + Math.random() * 3000))
  } else if (counter < 20) {
    setTimeout(() => {
      payMonkey(on_server, counter + 1)
    }, 500)
  }
}

if (argv.monkey) {
  if (base_port > 8000) {
    // add first hub by default and open limit
    PK.usedHubs.push(1)

    require('./internal_rpc/with_channel')({
      op: 'setLimits',
      partnerId: K.hubs[0].pubkey,
      asset: 1,
      soft_limit: K.soft_limit,
      hard_limit: K.hard_limit
    })
  }

  // only in monkey mode, not on end user node
  if (base_port != 8008) {
    Periodical.schedule('broadcast', K.blocktime * 1000)
  }

  let stubs = [
    'Chase Bank',
    'Bank of America',
    'Barclays',
    'BNP Paribas',
    'Capital One',
    'Citibank',
    'Deutsche Bank',
    'HSBC',
    'UBS'
  ]

  if (base_port > 8000 && base_port <= 8003) {
    let loc = on_server
      ? `wss://fairlayer.com:${base_port + 100}`
      : `ws://${localhost}:${base_port + 100}`
    require('./internal_rpc/create_hub')({
      fee_bps: 5,
      handle: stubs[base_port - 8001],
      location: loc,
      box_pubkey: bin(me.box.publicKey),
      add_routes: '1,2,3,4'
    })
  }

  if (base_port > 8003) {
    monkeys.splice(monkeys.indexOf(me.getAddress()), 1) // *except our addr

    setTimeout(() => {
      me.sendJSON(K.hubs[0], 'testnet', {
        action: 'faucet',
        asset: 1,
        amount: 10000000,
        address: me.getAddress()
      })
    }, K.blocktime * 1000)

    setTimeout(() => {
      payMonkey(on_server)

      // intended to fail
      me.payChannel({
        address:
          'ZUp5PARsn4X2xs8fEjYSRtWSTQqgkMnVax7CaLsBmp9kR36Jqon7NbqCakQ5jQ9w1t5gtGo3zfhTtQ2123123123DJJjZ#DOOMEDTOFAIL',
        amount: 100,
        asset: 1
      })
    }, 27000)
  }

  // below go pre-registred users
  if (!me.record || me.record.id > 10) {
    return
  }

  if (me.record.id == 1) {
    l('Scheduling e2e checks')
    // after a while the hub checks environment, db counts etc and test fails if anything is unexpected
    setTimeout(async () => {
      // no need to run test on server
      if (on_server) return

      await Periodical.syncChanges()

      let monkey5 = await getUserByIdOrKey(5)
      let monkey5ins = await getInsuranceSumForUser(5)

      // must be >100 after expected rebalance

      let failed = []

      if (me.metrics.settle.total == 0) failed.push('metrics.settled')
      if (me.metrics.fail.total == 0) failed.push('metrics.failed')
      if ((await Payment.count()) == 0) failed.push('payments')

      // was this entirely new user created since genesis?
      if (!monkey5) failed.push('monkey5')

      //if (monkey5ins < 100) failed.push('monkey5insurance')

      if ((await Block.count()) < 2) failed.push('blocks')
      if ((await Order.count()) < 1) failed.push('orders')
      if ((await Channel.count()) < 5) failed.push('deltas')
      if ((await Asset.count()) < 4) failed.push('assets')

      let e2e = 'e2e: ' + (failed.length == 0 ? 'success' : failed.join(', '))
      l(e2e)

      Raven.captureMessage(e2e, {
        level: 'info'
      })

      child_process.exec(`osascript -e 'display notification "${e2e}"'`)

      if (failed.length != 0) {
        //fatal(0)
      }

      //
    }, 80000)

    // adding onchain balances to monkeys
    for (var dest of monkeys) {
      let [box_pubkey, pubkey] = r(base58.decode(dest))
      me.batchAdd('depositTo', [1, [1000000, pubkey, 0]])
    }

    // creating an initial FRB sell for FRD
    me.batchAdd('createOrder', [2, 10000000, 1, 0.001 * 1000000])
  }

  if (me.record.id == 4) {
    // trigger the dispute from hub
    //me.CHEAT_dontack = true
    //me.CHEAT_dontwithdraw = true

    setTimeout(() => {
      me.payChannel({
        amount: 20000,
        address: monkeys[0],
        asset: 1
      })
    }, 12000)

    // create an asset
    me.batchAdd('createAsset', ['TESTCOIN', 13371337, 'Test coin', 'No goal'])
  }

  if (me.record.id == 3) {
    // just to make sure there's no leaky unescaped injection
    var xss = 'XSSCOIN' //\'"><img src=x onerror=alert(0)>'
    me.batchAdd('createAsset', ['XSS', 10000000, xss, xss])

    // buying bunch of FRB for $4
    me.batchAdd('createOrder', [1, 400, 2, 0.001 * 1000000])
  }

  if (me.record.id == 2) {
    // withdraw 12.34 from hub and deposit 9.12 to 3@1
    Channel.get(K.hubs[0].pubkey).then((ch) => {
      require('./internal_rpc/with_channel')({
        partnerId: toHex(ch.d.partnerId),
        op: 'withdraw',
        amount: 912
      })
    })

    require('./internal_rpc/external_deposit')({
      asset: 1,
      to: '3',
      hub: 'Medici',
      depositAmount: 912,
      invoice: 'test'
    })
  }
}
