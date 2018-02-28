WebSocketClient = require('./ws')
stringify = require('../lib/stringify')
Tx = require('./tx')

class Me {
  async init (username, seed) {
    this.username = username

    this.is_hub = false

    this.seed = seed
    this.id = nacl.sign.keyPair.fromSeed(this.seed)
    this.pubkey = bin(this.id.publicKey)

    this.mempool = []
    this.status = 'await'

    this.users = {}

    this.intervals = []

    this.block_keypair = nacl.sign.keyPair.fromSeed(kmac(this.seed, 'block'))
    this.block_pubkey = bin(this.block_keypair.publicKey).toString('hex')

    this.record = await this.byKey()

    PK.username = username
    PK.seed = seed.toString('hex')
    fs.writeFileSync('private/pk.json', JSON.stringify(PK))
  }

  async processQueue () {
    if (!this.queue) this.queue = []

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
    var methodId = methodMap(method)

    me.record = await me.byKey()

    switch (method) {
      case 'rebalanceHub':
      case 'rebalanceUser':

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

    var to_sign = r([me.record.nonce, methodId, args])

    var tx = r([
      me.record.id, ec(to_sign, me.id.secretKey), methodId, args
    ])

    confirm += ` Tx size ${tx.length}b, fee ${tx.length * K.tax}.`

    if (me.my_member && me.my_member == me.next_member) {
      me.mempool.push(tx)
    } else {
      me.send(K.members[0], 'tx', tx)

      l(r(tx))
    }

    l('Just broadcasted: ', method)

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

      me.users = {}

      me.wss.on('error', function (err) { console.error(err) })
      me.wss.on('connection', function (ws) {
        ws.on('message', (msg) => { me.queue.push(['external_rpc', ws, msg]) })
      })

      me.intervals.push(setInterval(require('./member'), 2000))

      for (var m of Members) {
        if (this.my_member != m) {
          // we need to have connections ready to all members
          this.send(m, 'auth', me.envelope(methodMap('auth')))
        }
      }

      if (this.is_hub) {
        // me.intervals.push(setInterval(require('./hub'), K.blocktime * 2000))
      }
    } else {
      // keep connection to hub open
      this.send(Members[0], 'auth', this.envelope(methodMap('auth')))
    }

    l('Set up sync')
    me.intervals.push(setInterval(sync, 3000))
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
      var c = await me.channel(pubkey)
      attrs.delta = c.they_promised
      attrs.balance = c.payable
    }

    await History.create(attrs)
  }

  parseDelta (body) {
    var [method, partner, nonce, delta, instant_until] = r(body)

    nonce = readInt(nonce)
    method = readInt(method)
    instant_until = readInt(instant_until)
    delta = readSInt(readInt(delta))

    if (method != methodMap('delta')) return false

    return [partner, nonce, delta, instant_until]
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
    if (compared == 0) throw 'Channel to self'

    var r = {
      // default insurance
      insurance: 0,
      ondelta: 0,
      nonce: 0,
      left: compared == -1
    }

    r.member = Members.find(m => m.pubkey.equals(partner))

    me.record = await me.byKey()

    r.d = (await Delta.findOrBuild({
      where: {
        myId: me.pubkey,
        partnerId: partner
      },
      defaults: {
        offdelta: 0,
        instant_until: 0,

        our_input_amount: 0,
        they_input_amount: 0,

        we_soft_limit: 0,
        we_hard_limit: 0,

        they_soft_limit: 0,
        they_hard_limit: 0,

        nonce: 0,
        status: 'ready',
        state: '{"locks":[]}'
      }
    }))[0]

    if (me.record) {
      var user = await me.byKey(partner)

      if (user) {
        r.partner = user.id

        var insurance = await Insurance.find({where: {
          leftId: r.left ? me.record.id : user.id,
          rightId: r.left ? user.id : me.record.id
        }})
      }
    }

    if (insurance) {
      r.insurance = insurance.insurance
      r.ondelta = insurance.ondelta
      r.nonce = insurance.nonce
    }

    // r.d.state = JSON.parse(r.d.state)

    r.delta = r.ondelta + r.d.offdelta
    r.state = parse(r.d.state)

    r.promised = 0
    r.they_promised = 0

    // three scenarios

    if (r.delta >= 0) {
      r.insured = r.insurance
      r.they_insured = 0

      r.they_promised = r.delta
    } else if (r.delta >= -r.insurance) {
      r.insured = r.insurance + r.delta
      r.they_insured = -r.delta
    } else {
      r.insured = 0
      r.they_insured = r.insurance

      r.promised = -(r.insurance + r.delta)
    }

    // view from hub's side of channel
    if (!r.left) {
      [r.insured, r.they_insured] = [r.they_insured, r.insured];
      [r.promised, r.they_promised] = [r.they_promised, r.promised];
    }

    r.payable = (r.insured - r.d.our_input_amount) + r.they_promised +
    (r.d.they_hard_limit - r.promised)

    r.they_payable = (r.they_insured - r.d.they_input_amount) + r.promised +
    (r.d.we_hard_limit - r.they_promised)

    // inputs not in blockchain yet, so we hold them temporarily

    return r
  }

  async processBlock (block) {
    var finalblock = block.slice(Members.length * 64)

    var total_shares = 0

    for (var i = 0; i < Members.length; i++) {
      var sig = (block.slice(i * 64, (i + 1) * 64))

      if (sig.equals(Buffer.alloc(64))) {

      } else if (ec.verify(finalblock, sig, Members[i].block_pubkey)) {
        total_shares += Members[i].shares
      } else {
        l(`Invalid signature for a given block. Halt!`)
        // return false
      }
    }

    if (total_shares < K.majority) {
      l('Not enough shares on a block')
      return false
    }

    var [methodId,
      built_by,
      prev_hash,
      timestamp,
      ordered_tx] = r(finalblock)

    timestamp = readInt(timestamp)

    if (readInt(methodId) != methodMap('block')) {
      return l('Wrong method for block')
    }

    if (finalblock.length > K.blocksize) {
      return l('Too long block')
    }

    if (timestamp < K.ts) {
      return l('New block from the past')
    }

    if (K.prev_hash != prev_hash.toString('hex')) {
      // l(`Must be based on ${K.prev_hash} but is using ${prev_hash}`)
      return false
    }

    //l(`Processing block built by ${readInt(built_by)}. Signed shares: ${total_shares}, tx: ${ordered_tx.length}`)

    var meta = {
      inputs_volume: 0,
      outputs_volume: 0
    }

    // processing transactions one by one
    for (var i = 0; i < ordered_tx.length; i++) {
      await Tx.processTx(ordered_tx[i], meta)
      K.total_tx++
      K.total_tx_bytes += ordered_tx[i].length
    }

    K.ts = timestamp
    K.prev_hash = toHex(sha3(finalblock))

    K.total_blocks++
    if (finalblock.length < K.blocksize - 1000) {
      K.usable_blocks++
    }

    K.total_bytes += block.length
    K.bytes_since_last_snapshot += block.length

    // every x blocks create new installer
    if (K.bytes_since_last_snapshot > K.snapshot_after_bytes) {
      K.bytes_since_last_snapshot = 0

      var old_snapshot = K.last_snapshot_height
      K.last_snapshot_height = K.total_blocks
    }

    // cron jobs
    if (K.total_blocks % 100 == 0) {
    }

    // executing proposals that are due
    let disputes = await Insurance.findAll({
      where: {delayed: K.usable_blocks},
      include: {all: true}
    })

    for (let dispute of disputes) {
      l(dispute)

      var delta = dispute.ondelta + dispute.dispute_delta

      if (delta < 0) {
        var user_gets = dispute.insurance + delta
        var hub_gets = dispute.insurance - user_gets
      } else {
        var user_gets = dispute.insurance
        var hub_gets = 0
      }

      var user = await User.findById(dispute.userId)
      var hub = await User.findById(dispute.hubId)

      user.balance += user_gets
      hub.balance += hub_gets
      dispute.insurance = 0
      dispute.delayed = null

      await user.save()
      await hub.save()
      await dispute.save()
    }

    // executing proposals that are due
    let jobs = await Proposal.findAll({
      where: {delayed: K.usable_blocks},
      include: {all: true}
    })

    for (let job of jobs) {
      var total_shares = 0
      for (let v of job.voters) {
        var voter = K.members.find(m => m.id == v.id)
        if (v.vote.approval && voter) {
          total_shares += voter.shares
        } else {

        }
      }

      if (total_shares < K.majority) continue

      l('Evaling ' + job.code)

      l(await eval(`(async function() { ${job.code} })()`))

      var patch = job.patch

      if (patch.length > 0) {
        me.request_reload = true
        var pr = require('child_process').exec('patch -p1', (error, stdout, stderr) => {
          console.log(error, stdout, stderr)
        })
        pr.stdin.write(patch)
        pr.stdin.end()

        l('Patch applied! Restarting...')
      }

      await job.destroy()
    }

    // block processing is over, saving current K
    fs.writeFileSync('data/k.json', stringify(K))

    if (K.bytes_since_last_snapshot == 0) {
      var filename = 'Failsafe-' + K.total_blocks + '.tar.gz'

      require('tar').c({
        gzip: true,
        sync: false,
        portable: true,
        noMtime: true,
        file: 'private/' + filename,
        filter: (path, stat) => {
          // must be deterministic

          stat.mtime = null
          stat.atime = null
          stat.ctime = null
          stat.birthtime = null

          // skip /private (blocks sqlite, proofs, local config)
          // tests, and all hidden/dotfiles
          if (path.startsWith('./.') || path.match(/(DS_Store|private|node_modules|test)/)) {
            return false
          } else {
            return true
          }
        }
      }, ['.'], _ => {
        fs.unlink('private/Failsafe-' + old_snapshot + '.tar.gz', () => {
          l('Removed old snapshot and created ' + filename)
        })
      })
    }

    // save final block in blockchain db and broadcast
    if (me.my_member) {
      await Block.create({
        prev_hash: Buffer.from(prev_hash, 'hex'),
        hash: sha3(finalblock),
        block: block
      })

      var blocktx = concat(inputMap('chain'), r([block]))
      // send finalblock to all websocket users if we're member

      if (me.wss) {
        me.wss.clients.forEach(client => client.send(blocktx))
      }
    }

    if (me.request_reload) {
      process.exit(0) // exit w/o error
    }
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
    // l(`Invoking ${method} in member ${m.id}`)

    if (me.users[m.pubkey]) {
      me.users[m.pubkey].send(tx)
    } else {
      me.users[m.pubkey] = new WebSocketClient()

      me.users[m.pubkey].onmessage = tx => {
        this.queue.push(['external_rpc', me.users[m.pubkey], bin(tx)])
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
