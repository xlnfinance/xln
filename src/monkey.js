// Fairlayer runs e2e tests on itself,
// different nodes acting like "monkeys" and doing different overlapping scenarios

if (argv.monkey) {
  if (me.my_hub) {
    // after a while the hub checks environment, db counts etc and test fails if anything is unexpected
    setTimeout(async () => {
      await me.syncdb()
      update_cache()

      let monkey5 = await User.idOrKey(5)
      let monkey5ins = await Insurance.sumForUser(5)

      // must be >100 after expected rebalance
      var alert = `${me.metrics.settle.total}/${me.metrics.fail.total}\n
Monkey5: ${monkey5 ? monkey5.asset(1) : 'N/A'}/${monkey5ins}\n
      `

      let failed = []

      if (me.metrics.settle.total < 100) failed.push('metrics.settled')
      if (me.metrics.fail.total < 5) failed.push('metrics.failed')

      if ((await Payment.count()) < 100) failed.push('payments')

      if (!monkey5) failed.push('monkey5')

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
        fatal(0)
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
      me.payMonkey()

      // intended to fail
      me.payChannel({
        address:
          'ZUp5PARsn4X2xs8fEjYSRtWSTQqgkMnVax7CaLsBmp9kR36Jqon7NbqCakQ5jQ9w1t5gtGo3zfhTtQ2123123123DJJjZ',
        amount: 100,
        asset: 1
      })
    }, 17000)
  }

  if (me.record) {
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
  }
}
