WebSocketClient = require('./ws')
stringify = require('../lib/stringify')
Tx = require('./tx')

class Me {
  async init (username, seed) {
    this.processBlock = require('./block')

    this.username = username

    this.is_hub = false

    this.seed = seed
    this.id = nacl.sign.keyPair.fromSeed(this.seed)
    this.pubkey = bin(this.id.publicKey)

    this.mempool = []
    this.status = 'await'

    this.users = {}
    this.hubs = {}

    this.queue = []

    this.intervals = []

    this.next_member = false

    this.block_keypair = nacl.sign.keyPair.fromSeed(kmac(this.seed, 'block'))
    this.block_pubkey = bin(this.block_keypair.publicKey).toString('hex')

    this.record = await this.byKey()

    PK.username = username
    PK.seed = seed.toString('hex')
    fs.writeFileSync('private/pk.json', JSON.stringify(PK))
  }

  async processQueue () {

    // first in first out - call rpc with ws and msg
    var action
    while (action = this.queue.shift()) {
      try {
        await RPC[action[0]](action[1], action[2])
      } catch (e) { l(e) }
    }

    // l("Setting timeout for queue")

    setTimeout(() => { me.processQueue() }, 50)
  }

  async byKey (pk) {
    if (!pk) {
      if (this.id) {
        pk = this.id.publicKey
      } else {
        return false
      }
    }

    return await User.findOne({
      where: { pubkey: bin(pk) }
    })
  }

  async processMempool () {
    var ordered_tx = []
    var total_size = 0

    var meta = {dry_run: true}

    for (var candidate of me.mempool) {
      if (total_size + candidate.length > K.blocksize) break

      var result = await Tx.processTx(candidate, meta)
      if (result.success) {
        ordered_tx.push(candidate)
        total_size += candidate.length
      } else {
        l(result.error)
        // punish submitter ip
      }
    }

    // flush it
    me.mempool = []

    me.precommit = r([
      methodMap('block'),
      me.record.id,
      Buffer.from(K.prev_hash, 'hex'),
      ts(),
      ordered_tx
    ])

    me.my_member.sig = ec(me.precommit, me.block_keypair.secretKey)

    if (K.majority > 1) {
      var needSig = r([
        me.my_member.block_pubkey,
        me.my_member.sig,
        me.precommit
      ])

      Members.map((c) => {
        if (c != me.my_member) { me.send(c, 'needSig', needSig) }
      })
    }

    return me.precommit
  }

  async broadcast (method, args) {
    me.record = await me.byKey()

    switch (method) {
      case 'rebalance':

        var confirm = 'Broadcasted globally!'
        break
      case 'propose':
        if (args[0].length <= 1) throw 'Rationale is required'

        if (args[2]) {
          // diff -urB . ../yo
          args[2] = fs.readFileSync('../' + args[2])
        }

        args = r(args)

        var confirm = 'Proposal submitted!'
        break

      case 'voteApprove':
      case 'voteDeny':

        var confirm = 'You voted!'

        break
    }

    var nonce = me.record.nonce + PK.pending_tx.length

    var to_sign = r([methodMap(method), nonce, args])

    var tx = r([
      me.record.id, ec(to_sign, me.id.secretKey), methodMap(method), nonce, args
    ])

    confirm += ` Tx size ${tx.length}b, fee ${tx.length * K.tax}.`

    PK.pending_tx.push({
      method: method,
      raw: toHex(tx)
    })

    if (me.my_member && me.my_member == me.next_member) {
      me.mempool.push(tx)
    } else {
      me.send(me.next_member, 'tx', tx)
    }

    l('Just broadcasted: '+method+' pendings: ', PK.pending_tx)

    return confirm
  }

  // this is off-chain for any kind of p2p authentication
  // no need to optimize for bandwidth
  // so full pubkey is used instead of id and JSON is used as payload
  envelope () {
    var msg = r(Object.values(arguments))
    return r([
      bin(this.id.publicKey),
      ec(msg, this.id.secretKey),
      msg
    ])
  }

  async start () {
    // in json pubkeys are in hex
    this.record = await this.byKey()

    for (var m of Members) {
      if (this.record && this.record.id == m.id) {
        this.my_member = m
        this.is_hub = !!this.my_member.hub
      }
    }

    await cache()
    this.intervals.push(setInterval(cache, 2000))

    this.intervals.push(setInterval(require('./member'), 2000))

    if (this.my_member) {
      // there's 2nd dedicated websocket server for member/hub commands
      var cb = () => {}
      me.member_server = cert ? require('https').createServer(cert, cb) : require('http').createServer(cb)
      me.member_server.listen(parseInt(this.my_member.location.split(':')[2]))

      l('Bootstrapping local server at: ' + this.my_member.location)

      me.wss = new ws.Server({
        server: me.member_server,
        maxPayload: 64 * 1024 * 1024
      })

      me.wss.on('error', function (err) { console.error(err) })
      me.wss.on('connection', function (ws) {
        ws.on('message', (msg) => { me.queue.push(['external_rpc', ws, msg]) })
      })

      for (var m of Members) {
        if (this.my_member != m) {
          // we need to have connections ready to all members
          this.send(m, 'auth', me.envelope(methodMap('auth')))
        }
      }

      if (this.is_hub) {
        me.intervals.push(setInterval(require('./hub'), K.blocktime * 1000))
      }
    } else {
      // keep connection to all hubs
      Members.map(m => {
        if (this.my_member != m) { this.send(m, 'auth', this.envelope(methodMap('auth'))) }
      })
    }

    l('Set up sync')
    me.intervals.push(setInterval(sync, K.blocktime * 1000))
  }

  async addHistory (pubkey, amount, desc, checkpoint = false) {
    var attrs = {
      userId: me.pubkey,
      hubId: 1,
      desc: desc,
      amount: amount
    }

    if (checkpoint) {
      // add current balances
      var ch = await me.channel(pubkey)
      attrs.delta = ch.they_promised
      attrs.balance = ch.payable
    }

    await History.create(attrs)
  }

  parseDelta (body) {
    var [method, partner, nonce, offdelta, instant_until] = r(body)

    nonce = readInt(nonce)
    method = readInt(method)
    instant_until = readInt(instant_until)
    offdelta = readSInt(offdelta)

    if (method != methodMap('offdelta')) return false

    return [partner, nonce, offdelta, instant_until]
  }

  async payChannel (opts) {
    var ch = await me.channel(opts.partner)

    if (ch.d.status != 'ready') {
      return [false, 'The channel is not ready to accept payments: ' + ch.d.status]
    }

    if (opts.amount < K.min_amount || opts.amount > K.max_amount) {
      return [false, `The amount must be between $${commy(K.min_amount)} and $${commy(K.max_amount)}`]
    }

    if (opts.amount > ch.payable) {
      return [false, 'Not enough funds']
    }

    ch.d.offdelta += ch.left ? -opts.amount : opts.amount
    ch.d.nonce++

    var newState = ch.d.getState()

    var body = r([
      methodMap('update'),
      // what we do to state
      [[methodMap('unlockedPayment'), opts.amount, opts.mediate_hub, opts.mediate_to, opts.invoice]],
      // sign what it turns into
      ec(newState, me.id.secretKey),
      // give our state for debug
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
      l('todo: ensure delivery')
    } else {
      await me.addHistory(opts.partner, -opts.amount, 'Sent to ' + opts.mediate_to.toString('hex').substr(0, 10) + '...', true)
    }

    // what do we do when we get the secret
    if (opts.return_to) purchases[toHex(opts.invoice)] = opts.return_to

    if (!me.send(opts.partner, 'update', signedState)) {
      l(`${opts.partner} not online, deliver later?`)
    }

    return [true, false]
  }

  async channels () {
    var channels = []

    for (var m of Members) {
      if (m.hub && (!me.record || me.record.id != m.id)) {
        var ch = await me.channel(m.pubkey)
        channels.push(ch)
      }
    }

    return channels
  }

  // accepts pubkey only
  async channel (partner) {
    var compared = Buffer.compare(me.pubkey, partner)
    if (compared == 0) return false

    var ch = {
      // default insurance
      insurance: 0,
      ondelta: 0,
      nonce: 0,
      left: compared == -1
    }

    ch.member = Members.find(m => m.pubkey.equals(partner))

    me.record = await me.byKey()

    var is_hub = (p)=>Members.find(m=>m.hub && m.pubkey.equals(p))

    ch.d = (await Delta.findOrBuild({
      where: {
        myId: me.pubkey,
        partnerId: partner
      },
      defaults: {
        offdelta: 0,

        our_input_amount: 0,
        they_input_amount: 0,

        we_soft_limit: is_hub(partner) ? K.risk : 0,
        we_hard_limit: is_hub(partner) ? K.hard_limit : 0,

        they_soft_limit: is_hub(me.pubkey) ? K.risk : 0,
        they_hard_limit: is_hub(me.pubkey) ? K.hard_limit :  0,

        nonce: 0,
        status: 'ready'
      }
    }))[0]

    var user = await me.byKey(partner)
    if (user) {
      ch.partner = user.id
      if (me.record) {
        ch.ins = await Insurance.find({where: {
          leftId: ch.left ? me.record.id : user.id,
          rightId: ch.left ? user.id : me.record.id
        }})
      }
    }

    if (ch.ins) {
      ch.insurance = ch.ins.insurance
      ch.ondelta = ch.ins.ondelta
      ch.nonce = ch.ins.nonce
    }

    // ch.d.state = JSON.parse(ch.d.state)

    ch.delta = ch.ondelta + ch.d.offdelta

    Object.assign(ch, resolveChannel(ch.insurance, ch.delta, ch.left))

    ch.payable = (ch.insured - ch.d.our_input_amount) + ch.they_promised +
    (ch.d.they_hard_limit - ch.promised)

    ch.they_payable = (ch.they_insured - ch.d.they_input_amount) + ch.promised +
    (ch.d.we_hard_limit - ch.they_promised)

    // inputs not in blockchain yet, so we hold them temporarily

    ch.bar = ch.promised + ch.insured + ch.they_insured + ch.they_promised

    return ch
  }

  // a generic interface to send a websocket message to some user or member

  send (m, method, tx) {
    tx = concat(inputMap(method), tx)

    // regular pubkey
    if (m instanceof Buffer) {
      if (me.users[m]) {
        me.users[m].send(tx)
        return true
      } else {
        var member = Members.find(f => f.pubkey.equals(m))
        if (member) {
          m = member
        } else {
          // not online
          return false
        }
      }
    }

    // member object
    //l(`Invoking ${method} in member ${m.id}`)

    if (me.users[m.pubkey]) {
      me.users[m.pubkey].send(tx)
    } else {
      me.users[m.pubkey] = new WebSocketClient()

      me.users[m.pubkey].onmessage = tx => {
        this.queue.push(['external_rpc', me.users[m.pubkey], bin(tx)])
      }

      me.users[m.pubkey].onerror = function (e) {
        l("Failed to open the socket")
      }
      me.users[m.pubkey].onopen = function (e) {
        if (me.id) {
          me.users[m.pubkey].send(concat(inputMap('auth'), me.envelope(methodMap('auth'))))
        }

        me.users[m.pubkey].send(tx)
      }

      me.users[m.pubkey].open(m.location)
    }

    return true
  }
}

module.exports = {
  Me: Me
}
