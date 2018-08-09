// Fairlayer runs e2e tests on itself,
// different nodes acting like "monkeys" and doing different overlapping scenarios

const payMonkey = async (on_server, counter = 1) => {
  const address = monkeys.randomElement()
  // offchain payment
  await me.payChannel({
    address: address,
    amount: 100 + Math.round(Math.random() * 100),
    asset: 1
  })

  const [_, pubkey] = r(base58.decode(address))
  const reg = await User.idOrKey(pubkey)

  // onchain payment (batched, not sent to validator yet)
  me.batch.push([
    'depositTo',
    1,
    [[Math.round(Math.random() * 1000), reg.id ? reg.id : pubkey, 0]]
  ])

  // run on server infinitely and with longer delays
  // but for local tests limit requests and run faster
  if (on_server) {
    // replenish with testnet faucet once in a while

    //if (ch.payable < 3000 && argv.monkey && !me.my_hub) {
    //if (counter % 300 == 10) me.getCoins()

    setTimeout(() => {
      payMonkey(on_server, counter + 1)
    }, Math.round(500 + Math.random() * 3000))
  } else if (counter < 20) {
    setTimeout(() => {
      payMonkey(on_server, counter + 1)
    }, Math.round(200))
  }
}

if (argv.monkey) {
  if (!me.record || me.record.id < 8) {
    return
  }

  setInterval(me.broadcast, 10000)

  if (me.record.id == 1) {
    // after a while the hub checks environment, db counts etc and test fails if anything is unexpected
    setTimeout(async () => {
      // no need to run test on server
      if (on_server) return

      await syncdb()
      update_cache()

      let monkey5 = await User.idOrKey(5)
      let monkey5ins = await Insurance.sumForUser(5)

      // must be >100 after expected rebalance

      let failed = []

      if (me.metrics.settle.total < 100) failed.push('metrics.settled')
      if (me.metrics.fail.total < 5) failed.push('metrics.failed')

      if ((await Payment.count()) < 100) failed.push('payments')

      // was this entirely new user created since genesis?
      if (!monkey5) failed.push('monkey5')

      //if (monkey5ins < 100) failed.push('monkey5insurance')

      if ((await Block.count()) < 2) failed.push('blocks')
      if ((await Order.count()) < 1) failed.push('orders')
      if ((await Delta.count()) < 5) failed.push('deltas')
      if ((await Asset.count()) < 4) failed.push('assets')

      let e2e =
        '\n\ne2e result: ' +
        (failed.length == 0 ? 'success' : failed.join(', '))
      l(e2e)
      child_process.exec(`osascript -e 'display notification "${e2e}"'`)

      if (failed.length != 0) {
        //fatal(0)
      }

      //
    }, 80000)

    // adding onchain balances to monkeys
    for (var dest of monkeys) {
      let [box_pubkey, pubkey] = r(base58.decode(dest))
      me.batch.push(['depositTo', 1, [[1000000, pubkey, 0]]])
    }

    // creating an initial FRB sell for FRD
    me.batch.push(['createOrder', [2, 10000000, 1, 0.001 * 1000000]])
  } else if (parseInt(base_port) > 8003) {
    monkeys.splice(monkeys.indexOf(me.address), 1) // *except our addr

    setTimeout(() => {
      me.getCoins(1, 10000000)
    }, 6000)

    setTimeout(() => {
      payMonkey(on_server)

      // intended to fail
      me.payChannel({
        address:
          'ZUp5PARsn4X2xs8fEjYSRtWSTQqgkMnVax7CaLsBmp9kR36Jqon7NbqCakQ5jQ9w1t5gtGo3zfhTtQ2123123123DJJjZ#DOOMEDTOFAIL',
        amount: 100,
        asset: 1
      })
    }, 17000)
  }

  if (me.record.id == 4) {
    // trigger the dispute from hub
    me.CHEAT_dontack = true
    me.CHEAT_dontwithdraw = true

    setTimeout(() => {
      me.payChannel({
        amount: 20000,
        address: monkeys[0],
        asset: 1
      })
    }, 12000)

    // create an asset
    me.batch.push([
      'createAsset',
      ['TESTCOIN', 13371337, 'Test coin', 'No goal']
    ])
  }

  if (me.record.id == 3) {
    // just to make sure there's no leaky unescaped injection
    var xss = '\'"><img src=x onerror=alert(0)>'
    me.batch.push(['createAsset', ['XSS', 10000000, xss, xss]])

    // buying bunch of FRB for $4
    me.batch.push(['createOrder', [1, 400, 2, 0.001 * 1000000]])
  }

  if (me.record.id == 2) {
    // withdraw 12.34 from hub and deposit 9.12 to 3@1
    require('./internal_rpc/rebalance')({
      asset: 1,

      chActions: [
        {
          partnerId: K.hubs[0].pubkey,
          withdrawAmount: 1234
        }
      ],

      externalDeposits: [
        {
          to: '3',
          hub: 'main',
          depositAmount: 912,
          invoice: 'test'
        }
      ]
    })
  }
}
