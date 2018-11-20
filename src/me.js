WebSocketClient = require('./utils/ws')
stringify = require('../lib/stringify')

class Me {
  // boilerplate attributes
  constructor() {
    this.status = 'await'

    this.my_hub = false

    this.mempool = []
    this.batch = []

    this.users = {}

    // array of sockets to frontends
    this.browsers = []

    this.busyPorts = [] // for cloud demos

    this.withdrawalRequests = {}

    // generic metric boilerplate: contains array of averages over time
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
      fees: getMetric(),

      //
      bandwidth: getMetric(),
      ecverify: getMetric()
    }
    cached_result.metrics = this.metrics

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

    this.last_react = new Date()

    PK.username = username
    PK.seed = seed.toString('hex')
    PK.usedHubs = []
    PK.usedAssets = [1, 2]

    await promise_writeFile(datadir + '/offchain/pk.json', JSON.stringify(PK))
  }

  // returns current address for offchain payments
  getAddress() {
    // if there are no hubs, no one can pay us
    if (PK.usedHubs.length == 0) return false

    let encodable = [bin(this.box.publicKey), this.pubkey, PK.usedHubs]
    return base58.encode(r(encodable))
  }

  is_me(pubkey) {
    return me.pubkey && me.pubkey.equals(pubkey)
  }

  // onchain events recorded for current user
  addEvent(data) {
    Event.create({
      blockId: K.total_blocks,
      data: stringify(data)
    })
  }

  batchAdd(method, args) {
    if (!me.record || !me.record.id) {
      react({alert: "You can't do onchain tx if you are not registred"})
      return false
    }

    let mergeable = ['withdrawFrom', 'depositTo']

    if (mergeable.includes(method)) {
      let exists = me.batch.find((b) => b[0] == method && b[1][0] == args[0])

      if (exists) {
        // add to existing array
        exists[1][1].push(args[1])
      } else {
        // create new set, withdrawals go first
        me.batch[method == 'withdrawFrom' ? 'unshift' : 'push']([
          method,
          [args[0], [args[1]]]
        ])
      }
    } else if (method == 'revealSecrets') {
      let exists = me.batch.find((b) => b[0] == method)
      // revealed secrets are not per-assets

      if (exists) {
        // add to existing array
        exists[1].push(args)
      } else {
        // create new set
        me.batch.push([method, [args]])
      }
    } else {
      me.batch.push([method, args])
    }
  }

  // compiles signed tx from current batch, not state changing
  async batch_estimate(opts = {}) {
    // we select our record again to get our current nonce
    if (!me.id || me.batch.length == 0) {
      return false
    }

    me.record = await getUserByIdOrKey(bin(me.id.publicKey))
    if (!me.record || !me.record.id) {
      //l("You can't broadcast if you are not registred")
      return false
    }

    let by_first = (a, b) => b[0] - a[0]

    let merged = me.batch.map((m) => {
      if (m[0] == 'depositTo' || m[0] == 'withdrawFrom') {
        m[1][1].sort(by_first)
      }

      return [methodMap(m[0]), m[1]]
    })

    let gaslimit = 0 //uncapped
    let gasprice = opts.gasprice ? parseInt(opts.gasprice) : K.min_gasprice

    let to_sign = r([
      methodMap('batch'),
      me.record.batch_nonce,
      gaslimit,
      gasprice,
      merged
    ])
    let signed_batch = r([me.record.id, ec(to_sign, me.id.secretKey), to_sign])

    return {
      signed_batch: signed_batch,
      size: to_sign.length,
      batch_nonce: me.record.batch_nonce,
      batch_body: merged
    }
  }

  // tell all validators the same thing
  gossip(method, data) {
    Validators.map((c) => {
      me.send(c, method, data)
    })
  }

  // signs data and adds our pubkey
  envelope() {
    var msg = r(Object.values(arguments))
    return r([bin(me.id.publicKey), ec(msg, me.id.secretKey), msg])
  }

  block_envelope() {
    var msg = r(Object.values(arguments))
    return r([
      bin(me.block_keypair.publicKey),
      ec(msg, me.block_keypair.secretKey),
      msg
    ])
  }

  async start() {
    // in json pubkeys are in hex
    me.record = await getUserByIdOrKey(bin(me.id.publicKey))

    if (me.record && me.record.id) {
      me.my_validator = Validators.find((m) => m.id == me.record.id)
      me.my_hub = K.hubs.find((m) => m.id == me.record.id)
    }

    // both validators and hubs must run external_wss
    if (me.my_validator) {
      Periodical.startValidator()
    }

    if (me.my_hub) {
      Periodical.startHub()
    }

    if (me.my_validator) {
      for (var m of Validators) {
        if (me.my_validator != m) {
          // we need to have connections ready to all validators
          me.send(m, 'auth', me.envelope(methodMap('auth')))
        }
      }

      // only validators need to run consensus
      l('Starting consensus reactor engine')
      me.consensus()
    } else {
      // keep connection to all hubs
      Validators.map((m) => {
        if (me.my_validator != m) {
          me.send(m, 'auth', me.envelope(methodMap('auth')))
        }
      })
    }

    if (argv.CHEAT) {
      // byzantine and testing flags
      argv.CHEAT.split(',').map((flag) => (me['CHEAT_' + flag] = true))
    }

    if (K.total_blocks > 1) {
      snapshotHash()
    } else {
      // initial run? go monkey e2e test
      require('./monkey')
    }

    Periodical.scheduleAll()
  }

  async startExternalRPC(advertized_url) {
    if (!advertized_url) {
      return l('Cannot start rpc on ', advertized_url)
    }

    if (me.external_wss_server) {
      return l('Already have external server started')
    }
    // there's 2nd dedicated websocket server for validator/hub commands

    me.external_wss_server = require('http').createServer(async (req, res) => {
      var [path, query] = req.url.split('?')
      // call /faucet?address=ME&amount=100&asset=1
      if (path.startsWith('/faucet')) {
        res.setHeader('Access-Control-Allow-Origin', '*')

        let args = querystring.parse(query)
        l('faucet ', args)

        let status = await me.payChannel({
          address: args.address,
          amount: parseInt(args.amount ? args.amount : 1000),
          asset: parseInt(args.asset ? args.asset : 1)
        })
        res.end(status)
      }
    })

    var port = parseInt(advertized_url.split(':')[2])
    me.external_wss_server.listen(on_server ? port + 200 : port)

    l(`Bootstrapping external_wss at: ${advertized_url}`)

    // lowtps/hightps
    me.external_wss = new (base_port == 8433 ? require('uws') : ws).Server({
      //noServer: true,
      //port: port,
      clientTracking: false,
      perMessageDeflate: false,
      server: me.external_wss_server,
      maxPayload: 64 * 1024 * 1024
    })

    me.external_wss.on('error', function(err) {
      l(err)
    })
    me.external_wss.on('connection', function(ws) {
      ws.on('message', (msg) => {
        RPC.external_rpc(ws, msg)
      })
    })
  }

  textMessage(partnerId, msg) {
    me.send(partnerId, 'textMessage', r([msg]))
  }

  // a generic interface to send a websocket message to some user or validator

  sendJSON(m, method, tx) {
    tx.method = method
    let msg = bin(JSON.stringify(tx))

    this.send(
      m,
      'JSON',
      r([bin(me.id.publicKey), ec(msg, me.id.secretKey), msg])
    )
  }

  // accepts Buffer or valid Service object
  send(m, method, tx) {
    var msg = concat(bin([methodMap(method)]), tx)

    // regular pubkey
    if (m instanceof Buffer) {
      //if (method == 'update') l(`Sending to ${trim(m)} `, toHex(sha3(tx)))

      if (me.users[m]) {
        me.users[m].send(msg, wscb)
        return true
      } else {
        // try to find by this pubkey among validators/hubs
        var validator = Validators.find((f) => f.pubkey.equals(m))
        var hub = K.hubs.find((f) => fromHex(f.pubkey).equals(m))
        if (validator) {
          m = validator
        } else if (hub) {
          m = hub
        } else {
          l(m, 'not online')
          return false
        }
      }
    }

    // validator object
    //l(`Invoking ${method} in validator ${m.id}`)

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
            concat(bin(methodMap('auth')), me.envelope(methodMap('auth'))),
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

Me.prototype.consensus = require('./consensus')

Me.prototype.processChain = require('./onchain/process_chain')
Me.prototype.processBlock = require('./onchain/process_block')
Me.prototype.processBatch = require('./onchain/process_batch')

Channel.get = require('./offchain/get_channel')

Me.prototype.payChannel = require('./offchain/pay_channel')
Me.prototype.flushChannel = require('./offchain/flush_channel')
Me.prototype.updateChannel = require('./offchain/update_channel')

module.exports = Me
