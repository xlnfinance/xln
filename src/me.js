WebSocketClient = require('./ws')
stringify = require('../lib/stringify')

class Me {
  // boilerplate attributes
  constructor() {
    this.my_hub = false

    this.mempool = []
    this.status = 'await'

    this.users = {}

    this.hubs = {}

    this.queue = []
    this.batch = []

    // generic metric boilerplate: contains array of averages per minute over time
    let getMetric = () => {
      return {
        max: 0,
        started: new Date(),
        total: 0,
        current: 0,
        last_avg: 0,
        avgs: []
      }
    }

    this.metrics = {
      volume: getMetric(),
      fail: getMetric(),
      settle: getMetric(),
      fees: getMetric()
    }
    cached_result.metrics = this.metrics

    this.updateMetricsInterval = 1000

    this.intervals = []
    // used to store current block to be added to chain
    this.proposed_block = {}
  }

  // derives needed keys from the seed, saves creds into pk.json
  async init(username, seed) {
    this.username = username

    this.seed = seed
    this.id = nacl.sign.keyPair.fromSeed(this.seed)
    this.pubkey = bin(this.id.publicKey)

    this.block_keypair = nacl.sign.keyPair.fromSeed(sha3('block' + this.seed))
    this.block_pubkey = bin(this.block_keypair.publicKey).toString('hex')

    this.box = nacl.box.keyPair.fromSecretKey(this.seed)

    this.address = base58.encode(r([bin(me.box.publicKey), me.pubkey]))

    this.last_react = new Date()

    PK.username = username
    PK.seed = seed.toString('hex')
    await promise_writeFile(datadir + '/offchain/pk.json', JSON.stringify(PK))
  }

  // returns true if no active browser ws now
  headless() {
    return !me.browser || me.browser.readyState != 1
  }

  is_me(pubkey) {
    return me.pubkey && me.pubkey.equals(pubkey)
  }

  // adds tx to batch, signs and broadcasts
  async broadcast() {
    // we select our record again to get our current nonce
    if (!me.id) {
      return false
    }

    me.record = await User.idOrKey(bin(me.id.publicKey))
    if (!me.record || !me.record.id) {
      //l("You can't broadcast if you are not registred")
      return false
    }

    if (PK.pending_batch) {
      return l('Only 1 tx is supported')
    }
    // TODO: make batch persistent on disk

    // recommended canonical batch structure: 4 money-related arrays before everything else
    var merged = [[map('revealSecrets'), []]]

    var per_asset = {}
    let mergeable = ['disputeWith', 'withdrawFrom', 'depositTo']
    // put into one of first arrays or add to the end
    me.batch.map((kv) => {
      //if (!kv) return

      if (kv[0] == 'revealSecrets') {
        // revealed secrets are not per-assets
        merged[0][1] = merged[0][1].concat(kv[1])
      } else if (mergeable.includes(kv[0])) {
        // asset specific actions

        if (!per_asset[kv[1]]) {
          per_asset[kv[1]] = [[], [], []]
        }
        let ind = mergeable.indexOf(kv[0])
        per_asset[kv[1]][ind] = per_asset[kv[1]][ind].concat(kv[2])
      } else {
        // these methods are not batchable and must go separately
        merged.push([map(kv[0]), kv[1]])
      }
    })
    me.batch = []

    // finally merging per-asset batches
    var multiasset = false
    for (var i in per_asset) {
      if (per_asset.hasOwnProperty(i)) {
        // sort withdraws and deposits (easier to analyze)
        per_asset[i][1].sort((a, b) => b[0] - a[0])
        per_asset[i][2].sort((a, b) => b[0] - a[0])

        if (i != '1' || multiasset) {
          // 1 is default anyway
          merged.push([map('setAsset'), [parseInt(i)]])
        }
        merged.push([map('disputeWith'), per_asset[i][0]])
        merged.push([map('withdrawFrom'), per_asset[i][1]])
        merged.push([map('depositTo'), per_asset[i][2]])
        multiasset = true
      }
    }

    // remove empty transactions
    merged = merged.filter((m) => m[1].length > 0)
    if (merged.length == 0) {
      return false
    }

    var nonce = me.record.nonce

    var to_sign = r([map('batch'), nonce, merged])

    var signed_batch = r([me.record.id, ec(to_sign, me.id.secretKey), to_sign])

    if (me.my_member && me.my_member == me.next_member(true)) {
      me.mempool.push(signed_batch)
    } else {
      me.send(me.next_member(true), 'tx', r([signed_batch]))
    }

    // saving locally to ensure it is added, and rebroadcast if needed
    PK.pending_batch = toHex(signed_batch)
  }

  // tell all validators the same thing
  gossip(method, data) {
    Members.map((c) => {
      me.send(c, method, data)
    })
  }

  // returns validator making block right now, use skip=true to get validator for next slot
  next_member(skip = false) {
    var now = ts()
    var currentIndex = Math.floor(now / K.blocktime) % K.total_shares
    var searchIndex = 0

    for (var i = 0; i < Members.length; i++) {
      searchIndex += Members[i].shares

      if (searchIndex > currentIndex) {
        var current = Members[i]

        if (currentIndex + 1 == K.total_shares) {
          // go back to 0
          var next = Members[0]
        } else if (currentIndex + 1 < searchIndex) {
          // same member
          var next = current
        } else {
          // next member
          var next = Members[i + 1]
        }
        break
      }
    }
    return skip ? next : current
  }

  // signs data and adds our pubkey
  envelope() {
    var msg = r(Object.values(arguments))
    return r([bin(this.id.publicKey), ec(msg, this.id.secretKey), msg])
  }

  block_envelope() {
    var msg = r(Object.values(arguments))
    return r([
      bin(this.block_keypair.publicKey),
      ec(msg, this.block_keypair.secretKey),
      msg
    ])
  }

  async start() {
    // in json pubkeys are in hex
    this.record = await User.idOrKey(bin(me.id.publicKey))

    if (this.record) {
      this.my_member = Members.find((m) => m.id == this.record.id)
      this.my_hub = K.hubs.find((m) => m.id == this.record.id)
    }

    /*

    this.intervals.push(
      setInterval(async () => {
        var flushable = await Delta.findAll({
          where: {
            flush_requested_at: {
              [Op.lt]: new Date() - K.flush_timeout
            }
          }
        })

        for (var fl of flushable) {
          //l('Flushing channel for ', fl.partnerId)
          //ch.d.flush_requested_at = null
          await me.flushChannel(fl.partnerId, 1, true)
        }

        if (flushable.length > 0) {
          react()
        }
      }, K.flush_timeout)
    )
    */

    if (me.my_member) {
      // there's 2nd dedicated websocket server for member/hub commands
      var cb = () => {}
      me.member_server = cert
        ? require('https').createServer(cert, cb)
        : require('http').createServer(cb)
      var member_port = parseInt(this.my_member.location.split(':')[2])
      me.member_server.listen(member_port)

      l(`Bootstrapping local server at: ${this.my_member.location}`)

      // lowtps/hightps
      //(base_port == 8433 ? require('uws') : ws)

      me.external_wss = new (base_port == 8433 ? require('uws') : ws).Server({
        //noServer: true,
        //port: member_port,
        clientTracking: false,
        perMessageDeflate: false,
        server: me.member_server,
        maxPayload: 64 * 1024 * 1024
      })

      me.external_wss.on('error', function(err) {
        fatal(err)
      })
      me.external_wss.on('connection', function(ws) {
        ws.on('message', (msg) => {
          RPC.external_rpc(ws, msg)
        })
      })

      for (var m of Members) {
        if (this.my_member != m) {
          // we need to have connections ready to all members
          this.send(m, 'auth', me.envelope(map('auth')))
        }
      }

      // only members need to run consensus
      l('Starting consensus reactor engine')
      me.consensus()
    } else {
      // keep connection to all hubs
      Members.map((m) => {
        if (this.my_member != m) {
          this.send(m, 'auth', this.envelope(map('auth')))
        }
      })
    }

    if (argv.CHEAT) {
      // byzantine and testing flags
      argv.CHEAT.split(',').map((flag) => (me['CHEAT_' + flag] = true))
    }

    l('Setting up intervals')
    // request latest blocks from nearest validator
    me.intervals.push(setInterval(sync, 2000))
    // cache onchain data regularly to present in Explorers
    me.intervals.push(setInterval(update_cache, K.blocktime * 2000))

    if (K.total_blocks > 1) {
      snapshotHash()
    }

    // ensures all channels were acked, otherwise reveal hashlocks and start dispute onchain ASAP
    me.intervals.push(setInterval(me.ensureAck, K.blocktime * 1000))

    // updates tps metrics for nice sparklines graphs
    me.intervals.push(setInterval(me.updateMetrics, me.updateMetricsInterval))

    /*
    me.intervals.push(
      setInterval(() => {
        // clean up old payments: all acked fails and settles
        Payment.destroy({
          where: {
            [Op.or]: [{type: 'del', status: 'ack'}]
          }
        })
      }, 120000)
    )
    */

    if (me.my_hub || me.my_member) {
      me.intervals.push(setInterval(me.syncdb, K.blocktime * 4000))
    }

    if (me.my_hub) {
      me.intervals.push(
        setInterval(require('./offchain/rebalance'), K.blocktime * 5000)
      )

      // hubs have force react regularly
      me.intervals.push(
        setInterval(() => {
          react({})
        }, 15000)
      )
    }

    if (argv.monkey) {
      // user specific e2e tests
      if (this.record) {
        if (this.record.id == 4) {
          // trigger the dispute from hub
          me.CHEAT_dontack = true
          me.CHEAT_dontwithdraw = true
          me.payChannel({
            amount: 20000,
            destination: randos[0],
            asset: 1
          })

          // create an asset
          me.batch.push([
            'createAsset',
            ['TEST2', 13371337, 'Test coin', 'No goal']
          ])
        }

        if (this.record.id == 3) {
          me.batch.push([
            'createAsset',
            ['TEST3', 10000000, 'Test coin by 3', 'No goal']
          ])

          // buying bunch of FRB for $4
          me.batch.push(['createOrder', [1, 400, 2, 0.001 * 1000000]])
        }
      }

      // if we are hub: plan a test check, otherwise start paying randomly.
      if (me.my_hub) {
        // adding onchain balances to randos
        for (var dest of randos) {
          let [box_pubkey, pubkey] = r(base58.decode(dest))
          me.batch.push(['depositTo', 1, [[1000000, pubkey, 0]]])
        }

        // creating an initial FRB sell for FRD
        me.batch.push(['createOrder', [2, 10000000, 1, 0.001 * 1000000]])

        setTimeout(async () => {
          // making sure in 30 sec that all test payments were successful by looking at the metrics

          await me.syncdb()
          update_cache()

          let monkey5 = await User.idOrKey(5)
          let monkey5ins = await Insurance.sumForUser(5)

          // must be >100 after expected rebalance
          var alert = `${me.metrics.settle.total}/${me.metrics.fail.total}\n
Monkey5: ${monkey5 ? monkey5.asset(1) : 'N/A'}/${monkey5ins}\n
Blocks: ${await Block.count()}\n
Payments: ${await Payment.count()}\n
Orders: ${await Order.count()}\n
Assets: ${await Asset.count()}\n
Deltas: ${await Delta.count()}\n
          `

          l(alert)

          child_process.exec(`osascript -e 'display notification "${alert}"'`)
        }, 80000)
      } else if (parseInt(base_port) > 8003) {
        randos.splice(randos.indexOf(me.address), 1) // *except our addr

        setTimeout(() => {
          me.getCoins(1, 10000000)
        }, 6000)

        setTimeout(() => {
          me.payRando()

          // intended to fail
          me.payChannel({
            destination:
              'ZUp5PARsn4X2xs8fEjYSRtWSTQqgkMnVax7CaLsBmp9kR36Jqon7NbqCakQ5jQ9w1t5gtGo3zfhTtQ2123123123DJJjZ',
            amount: 100,
            asset: 1
          })
        }, 17000)
      }
    }
  }

  getCoins(asset = 1, amount = 1000) {
    l('Using faucet')
    me.send(
      fromHex(K.hubs[0].pubkey),
      'testnet',
      r([1, asset, amount, bin(me.address)])
    )
  }

  async syncdb() {
    return await q('syncdb', async () => {
      var all = []

      fs.writeFileSync(
        './' + datadir + '/onchain/k.json',
        stringify(K),
        function(err) {
          if (err) return console.log(err)
        }
      )
      
      // saving all deltas and corresponding payment objects to db
      // it only saves changed records, so call save() on everything

      for (var key in cache.users) {
        var u = cache.users[key]

        // if already registred, save
        if (u.id) {
          all.push(u.save())
        }
      }

      for (var key in cache.ins) {
        var u = cache.ins[key]

        // if already registred, save
        if (u.id) {
          all.push(u.save())
        }
      }

      for (var key in cache.ch) {
        var ch = cache.ch[key]
        all.push(ch.d.save())

        ch.payments = ch.payments.filter((t) => {
          all.push(t.save())

          return t.type + t.status != 'delack'
        })

        if (ch.last_used < ts() - K.cache_timeout) {
          delete cache.ch[key]
          l('Evict from memory idle channel: ' + key)
        }
      }

      await Promise.all(all)
      l('syncdb done')

      return true
    })
  }

  // takes channels with supported hubs (verified and custom ones)
  async channels() {
    let channels = []

    let assets = cached_result.assets //await Asset.findAll()
    // all assets with all hubs

    if (me.my_hub) {
      // find all existing channels (if you are hub)
      var deltas = await Delta.findAll()
      for (var d of deltas) {
        if (!K.hubs.find((h) => fromHex(h.pubkey).equals(d.partnerId))) {
          var ch = await me.getChannel(d.partnerId, d.asset)
          channels.push(ch)
        }
      }
    } else {
      for (var m of K.hubs) {
        if (!me.record || me.record.id != m.id) {
          for (let asset of assets) {
            var ch = await me.getChannel(fromHex(m.pubkey), asset.id)
            channels.push(ch)
          }
        }
      }
    }

    return channels
  }

  async payRando(counter = 1) {
    var dest = randos[Math.floor(Math.random() * randos.length)]
    // offchain payment
    await me.payChannel({
      destination: dest,
      amount: 100 + Math.round(Math.random() * 100),
      asset: 1
    })

    let [box_pubkey, pubkey] = r(base58.decode(dest))
    var reg = await User.idOrKey(pubkey)

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
        me.payRando(counter + 1)
      }, Math.round(500 + Math.random() * 3000))
    } else if (counter < 20) {
      setTimeout(() => {
        me.payRando(counter + 1)
      }, Math.round(200))
    }
  }

  updateMetrics() {
    for (let name of Object.keys(me.metrics)) {
      let m = me.metrics[name]
      m.total += m.current
      m.last_avg = Math.round(m.current)

      if (m.last_avg > m.max) {
        m.max = m.last_avg
      }
      m.avgs.push(m.last_avg)

      // free up memory
      if (m.avgs.length > 600) m.avgs.shift()

      m.current = 0 // zero the counter for next period
    }
  }

  // a generic interface to send a websocket message to some user or member

  send(m, method, tx) {
    var msg = concat(bin([map(method)]), tx)

    // regular pubkey
    if (m instanceof Buffer) {
      //if (method == 'update') l(`Sending to ${trim(m)} `, toHex(sha3(tx)))

      if (me.users[m]) {
        me.users[m].send(msg, wscb)
        return true
      } else {
        var member = Members.find((f) => f.pubkey.equals(m))
        if (member) {
          m = member
        } else {
          l(m, 'not online')
          return false
        }
      }
    }

    // member object
    //l(`Invoking ${method} in member ${m.id}`)

    if (me.users[m.pubkey]) {
      return me.users[m.pubkey].send(msg, wscb)
    } else {
      me.users[m.pubkey] = new WebSocketClient()

      me.users[m.pubkey].onmessage = (msg) => {
        RPC.external_rpc(me.users[m.pubkey], msg)
      }

      me.users[m.pubkey].onerror = function(e) {
        l('Failed to open the socket')
      }
      me.users[m.pubkey].onopen = function(e) {
        if (me.id) {
          me.users[m.pubkey].send(
            concat(bin(map('auth')), me.envelope(map('auth'))),
            l
          )
        }

        me.users[m.pubkey].send(msg, wscb)
      }

      me.users[m.pubkey].open(m.location)
    }

    return true
  }
}

Me.prototype.consensus = require('./onchain/consensus')
Me.prototype.processBlock = require('./onchain/process_block')
Me.prototype.processBatch = require('./onchain/process_batch')

Me.prototype.payChannel = require('./offchain/pay_channel')
Me.prototype.flushChannel = require('./offchain/flush_channel')
Me.prototype.getChannel = require('./offchain/get_channel')
Me.prototype.updateChannel = require('./offchain/update_channel')
Me.prototype.ensureAck = require('./offchain/ensure_ack')

module.exports = {
  Me: Me
}
