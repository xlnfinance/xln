WebSocketClient = require('./ws')
stringify = require('../lib/stringify')
Tx = require('./tx')


RPC = {
  internal_rpc: require('./internal_rpc'),
  external_rpc: require('./external_rpc')
}


class Me {

  async init (username, seed) {
    this.username = username

    this.is_hub = false

    this.seed = seed
    this.id = nacl.sign.keyPair.fromSeed(this.seed)
    this.id.publicKey = bin(this.id.publicKey)

    this.mempool = []
    this.status = 'await'


    this.users = {}

    this.intervals = []

    this.block_keypair = nacl.sign.keyPair.fromSeed(kmac(this.seed, 'block'))
    this.block_pubkey = bin(this.block_keypair.publicKey).toString('hex')

    PK.username = username
    PK.seed = seed.toString('hex')
    fs.writeFileSync('private/pk.json', JSON.stringify(PK))
  }

  async processQueue () {
    if (!this.queue) this.queue = []

    // first in first out - call rpc with ws and msg
    var action
    while( action = this.queue.shift() ){
      await RPC[action[0]](action[1], action[2])
    }

    //l("Setting timeout for queue")

    setTimeout(()=>{ me.processQueue() }, 100)
  }

  async byKey (pk) {
    if (!pk) pk = this.id.publicKey
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

    var block_number = K.total_blocks
    block_number++

    var prev_hash = K.prev_hash
    // block has current height, hash of prev block , ts()

    me.precommit = r([
      block_number,
      methodMap('block'),
      Buffer.from(prev_hash, 'hex'),
      ts(),
      ordered_tx
    ])

    d('Built ordered ', ordered_tx)

    me.my_member.sig = ec(me.precommit, me.block_keypair.secretKey)

    if (K.majority > 1) {
      var needSig = r([
        me.my_member.block_pubkey,
        me.my_member.sig,
        me.precommit
      ])
      

      me.members.map((c) => {
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
        assert(args[0].length > 1, 'Rationale is required')

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

    l('Just broadcasted ', tx)

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
    await cache()

    // in json pubkeys are in hex
    this.record = await this.byKey()

    for (var m of this.members) {
      if (this.record && this.record.id == m.id) {
        this.my_member = m
        this.is_hub = this.my_member.hub
      }
    }

    l('start caching')
    me.intervals.push(setInterval(cache, 1000))

    if (this.my_member) {
      // there's 2nd dedicated websocket server for member/hub commands
      var cb = () => {}
      var member_server = cert ? require('https').createServer(cert, cb) : require('http').createServer(cb)
      member_server.listen(parseInt(this.my_member.location.split(':')[2]))

      me.wss = new ws.Server({
        server: member_server,
        maxPayload: 64 * 1024 * 1024
      })

      me.users = {}

      me.wss.on('error', function (err) { console.error(err) })
      me.wss.on('connection', function (ws) {
        ws.on('message', (msg) => { me.queue.push(['external_rpc', ws, msg]) })
      })

      me.intervals.push(setInterval(require('./member'), 2000))

      for (var m of this.members) {
        if (this.my_member != m) {
          // we need to have connections ready to all members
          this.send(m, 'auth', me.envelope( methodMap('auth') ))
        }
      }

      if (this.is_hub) {
        me.intervals.push(setInterval(async () => {
          var h = await (require('./hub')())

          if (h.ins.length > 0 || h.outs.length > 0) {
            await this.broadcast('rebalanceHub', r([0, h.ins, h.outs]))
          }
        }, K.blocktime * 1000))
      }
    } else {
      // keep connection to hub open
      this.send(K.members[0], 'auth', this.envelope( methodMap('auth') ))

      l('Set up sync')
      me.intervals.push(setInterval(sync, K.blocktime * 1000))
    }
  }

  async addHistory (amount, desc, checkpoint=false) {
    var attrs = {
      userId: me.pubkey,
      hubId: 1,
      desc: desc,
      amount: amount
    }

    if (checkpoint) {
      // add current balances
      var c = await me.channel(1)
      attrs.rdelta = c.rdelta
      attrs.balance = c.total
    }

    await History.create(attrs)
  }





  parseDelta (body) {
    var [method, counterparty, nonce, delta, instant_until] = r(body)

    nonce = readInt(nonce)
    method = readInt(method)
    instant_until = readInt(instant_until)
    delta = readSInt(readInt(delta))

    assert(method == methodMap('delta'))

    return [counterparty, nonce, delta, instant_until]
  }





  async payChannel (opts) {
    if (opts.amount < 100) {
      return [false, '$1.00 is the minimum amount']
    }

    var ch = await me.channel(opts.counterparty)

    var new_delta = ch.rdelta + (me.is_hub ? opts.amount : -opts.amount)

    // checking boundaries
    if (-new_delta > ch.insurance) {
      return [false, 'Not enough funds']
    }

    if (new_delta > K.risk_limit) {
      return [false, 'Hubs cannot promise over risk limit']
    }

    if (ch.delta_record.status != 'ready') {
      //return [false, 'The channel is not ready to accept payments: ' + ch.delta_record.status]
    }

    ch.delta_record.delta += (me.is_hub ? opts.amount : -opts.amount)
    ch.delta_record.nonce++


    var newState = ch.delta_record.getState()

    var body = r([
      methodMap('update'),
      // what we do to state
      [[methodMap('unlockedPayment'), opts.amount, opts.mediate_to, opts.invoice]], 
      // sign what it turns into
      ec(newState, me.id.secretKey),
      // give our state for debug
      newState
    ])

    var signedState = r([
      bin(me.id.publicKey), 
      ec(body, me.id.secretKey),
      body
    ])
    
    ch.delta_record.status = 'await'
    
    await ch.delta_record.save()

    // todo: ensure delivery
    if (me.is_hub) {

    } else {
      await me.addHistory(-opts.amount, 'Sent to ' + opts.mediate_to.toString('hex').substr(0, 10) + '...', true)
    }

    // what do we do when we get the secret
    if (opts.return_to) purchases[toHex(opts.invoice)] = opts.return_to

    if (!me.send(opts.counterparty == 1 ? K.members[0] : opts.counterparty, 'update', signedState)) {
      l(`${opts.counterparty} not online, deliver later?`)
    }

    return [true, false]
  }

  async channel (counterparty) {

    if (!me.is_hub && counterparty != 1) {
      assert(K.members[0].pubkey == toHex(counterparty))
      counterparty = 1
    }



    var r = {
      // onchain fields
      insurance: 0,
      rebalanced: 0,
      nonce: 0,

      // offchain delta_record

      // for convenience
      rdelta: 0,
      failsafe: 0,
      total: 0
    }

    me.record = await me.byKey()

    var delta = await Delta.findOrBuild({
      where: me.is_hub ? {
        hubId: me.record.id,
        userId: counterparty
      } : {
        hubId: counterparty,
        userId: bin(me.id.publicKey)
      },
      defaults: {
        delta: 0,
        instant_until: 0,
        nonce: 0,
        status: 'ready',
        state: '{"locks":[]}'
      }
    })


    if (me.is_hub) {
      var user = await me.byKey(counterparty)
      if (user) {
        var insurance = await Insurance.find({where: {
          userId: user.id,
          hubId: me.record.id
        }})
      }
    } else if (me.record) {
      var insurance = await Insurance.find({where: {
        userId: me.record.id,
        hubId: counterparty
      }})
    }

    if (insurance) {
      r.insurance = insurance.insurance
      r.rebalanced = insurance.rebalanced
      r.nonce = insurance.nonce
    }

    r.delta_record = delta[0]

    //r.delta_record.state = JSON.parse(r.delta_record.state)

    r.rdelta = r.rebalanced + r.delta_record.delta
    r.total = r.insurance + r.rdelta

    r.state = parse(r.delta_record.state)

    r.receivable = 1000000 - r.rdelta

    if (r.rdelta >= 0) {
      r.failsafe = r.insurance
    } else {
      r.failsafe = r.insurance + r.rdelta
    }

    return r
  }

  async processBlock (block) {
    var finalblock = block.slice(me.members.length * 64)

    var total_shares = 0

    for (var i = 0; i < me.members.length; i++) {
      var sig = (block.slice(i * 64, (i + 1) * 64))

      if (sig.equals(Buffer.alloc(64))) {

      } else if (ec.verify(finalblock, sig, me.members[i].block_pubkey)) {
        total_shares += me.members[i].shares
      } else {
        l(`Invalid signature for a given block. Halt!`)
        // return false
      }
    }

    if (total_shares < K.majority) {
      l('Not enough shares on a block')
      return false
    }

    var [block_number,
      methodId,
      prev_hash,
      timestamp,
      ordered_tx] = r(finalblock)

    block_number = readInt(block_number)
    timestamp = readInt(timestamp)
    prev_hash = prev_hash.toString('hex')

    assert(readInt(methodId) == methodMap('block'), 'Wrong method for block')
    assert(finalblock.length <= K.blocksize, 'Invalid block')

    if (timestamp < K.ts) {
      l('New block from the past')
      return false
    }
    //, 

    if (K.prev_hash != prev_hash) {
      l(`Must be based on ${K.prev_hash} but is using ${prev_hash}`)
      return false
    }

    d(`Processing ${block_number}. Signed shares: ${total_shares}, tx: ${ordered_tx.length}`)

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
      K.last_snapshot_height = K.total_blocks
    } else {

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

      var rdelta = dispute.rebalanced + dispute.dispute_delta

      if (rdelta < 0) {
        var user_gets = dispute.insurance + rdelta
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
      trustlessInstall()
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
        return false
      }
    } else {
      // member object
      l(`Invoking ${method} in member ${m.id}`)

      if (me.users[m.pubkey]) {
        me.users[m.pubkey].send(tx)
      } else {
        me.users[m.pubkey] = new WebSocketClient()

        me.users[m.pubkey].onmessage = tx => {
          this.queue.push(['external_rpc', me.users[m.pubkey], bin(tx)])
        }

        me.users[m.pubkey].onopen = function (e) {
          if (me.id) { 
            me.users[m.pubkey].send(concat(inputMap('auth'), me.envelope( methodMap('auth') ))) 
          }

          me.users[m.pubkey].send(tx)
        }

        me.users[m.pubkey].open(m.location)
      }

      return true

    }

  }


}

module.exports = {
  Me: Me
}
