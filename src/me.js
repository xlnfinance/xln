WebSocketClient = require('../lib/ws')
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

    this.intervals = []

    this.proposed_block = {}
  }

  // derives needed keys from the seed, saves creds into pk.json
  async init(username, seed) {
    this.username = username

    this.seed = seed
    this.id = nacl.sign.keyPair.fromSeed(this.seed)
    this.pubkey = bin(this.id.publicKey)

    this.block_keypair = nacl.sign.keyPair.fromSeed(kmac(this.seed, 'block'))
    this.block_pubkey = bin(this.block_keypair.publicKey).toString('hex')

    this.box = nacl.box.keyPair.fromSecretKey(this.seed)

    this.address = base58.encode(r([bin(me.box.publicKey), me.pubkey]))

    console.log(this.address)

    this.record = await this.byKey()

    PK.username = username
    PK.seed = seed.toString('hex')
    fs.writeFileSync(datadir + '/offchain/pk.json', JSON.stringify(PK))
  }

  // all callbacks are processed one by one for race condition safety (for now)
  async processQueue() {
    // first in first out - call rpc with ws and msg
    var action
    while ((action = this.queue.shift())) {
      try {
        await action()
      } catch (e) {
        l(e)
      }
    }

    // l("Setting timeout for queue")
    setTimeout(() => {
      me.processQueue()
    }, 50)
  }

  async addQueue(job) {
    job()
    // if high load, execute now with semaphores
    //me.queue.push(job)
    /*
    var j = await lock('job')
    await job()
    j()

    if (me.queue.length == 1) {
      me.processQueue()
    }
    */
  }

  async byKey(pk) {
    if (!pk) {
      if (this.id) {
        pk = this.id.publicKey
      } else {
        return false
      }
    }

    return await User.findOne({
      where: {pubkey: bin(pk)}
    })
  }

  // adds tx to batch, signs and broadcasts
  async broadcast() {
    me.record = await me.byKey()
    if (!me.record) {
      //l("You can't broadcast if you are not registred")
      return false
    }

    if (false) {
      require('./offchain/rebalance')()
      // enforces hashlocks
      me.ensureAck()
    }
    /*
      if (this.my_hub) {
        me.intervals.push(
          setInterval(require('./offchain/rebalance'), K.blocktime * 1000)
        )
      }*/

    if (PK.pending_batch) {
      return l('Only 1 tx is supported')
    }
    // TODO: make batch persistent on disk

    // recommended canonical batch structure: 4 money-related arrays before everything else
    var merged = [
      [methodMap('revealSecrets'), []],
      [methodMap('disputeWith'), []],
      [methodMap('withdrawFrom'), []],
      [methodMap('depositTo'), []]
    ]
    var m
    // put into one of first arrays or add to the end
    me.batch.map((kv) => {
      //if (!kv) return

      if (kv[0] == 'revealSecrets') {
        m = 0
      } else if (kv[0] == 'disputeWith') {
        m = 1
      } else if (kv[0] == 'withdrawFrom') {
        m = 2
      } else if (kv[0] == 'depositTo') {
        m = 3
        // these methods have non mergeable args
      } else if (kv[0] == 'propose' || kv[0] == 'vote') {
        merged.push([methodMap(kv[0]), kv[1]])
        return
      }
      merged[m][1] = merged[m][1].concat(kv[1])
    })
    // remove empty transactions
    merged = merged.filter((m) => m[1].length > 0)
    if (merged.length == 0) {
      return false
    }

    l('After merging to broadcast: ', merged)

    var nonce = me.record.nonce

    var to_sign = r([methodMap('batch'), nonce, merged])

    var signed_batch = r([me.record.id, ec(to_sign, me.id.secretKey), to_sign])

    // saving locally to ensure it is added, and rebroadcast if needed
    PK.pending_batch = toHex(signed_batch)
    me.batch = []

    if (me.my_member && me.my_member == me.next_member()) {
      me.mempool.push(signed_batch)
    } else {
      me.send(me.next_member(), 'tx', r([signed_batch]))
    }
  }

  // tell all validators the same thing
  gossip(method, data) {
    Members.map((c) => {
      me.send(c, method, data)
    })
  }

  next_member(skip = false) {
    var now = ts()
    var currentIndex = Math.floor(now / K.blocktime) % K.total_shares
    var searchIndex = 0

    for (var i in Members) {
      searchIndex += Members[i].shares

      if (searchIndex > currentIndex) {
        var current = Members[i]

        if (searchIndex > currentIndex + 1) {
          // next slot is still theirs
          var next = current
        } else {
          // take next member or rewind back to 0
          var next = Members[(i + 1) % K.members.length]
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
    this.record = await this.byKey()

    if (this.record) {
      this.my_member = Members.find((m) => m.id == this.record.id)
      this.my_hub = K.hubs.find((m) => m.id == this.record.id)
    }

    await cache()
    me.processQueue()

    /*
    this.intervals.push(setInterval(cache, 10000))

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
          await me.flushChannel(fl.partnerId)
        }

        if (flushable.length > 0) {
          react()
        }
      }, K.flush_timeout)
    )
    */

    if (this.my_member) {
      me.consensus()

      // there's 2nd dedicated websocket server for member/hub commands
      var cb = () => {}
      me.member_server = cert
        ? require('https').createServer(cert, cb)
        : require('http').createServer(cb)
      me.member_server.listen(parseInt(this.my_member.location.split(':')[2]))

      l(`Bootstrapping local server at: ${this.my_member.location}`)

      me.external_wss = new ws.Server({
        server: me.member_server,
        maxPayload: 64 * 1024 * 1024
      })

      me.external_wss.on('error', function(err) {
        fatal(err)
      })
      me.external_wss.on('connection', function(ws) {
        ws.on('message', async (msg) => {
          me.addQueue(async () => {
            return RPC.external_rpc(ws, msg)
          })
          /*var unlock = await mutex('external_rpc')
          await RPC.external_rpc(ws, msg)
          unlock()*/
        })
      })

      for (var m of Members) {
        if (this.my_member != m) {
          // we need to have connections ready to all members
          this.send(m, 'auth', me.envelope(methodMap('auth')))
        }
      }
    } else {
      // keep connection to all hubs
      Members.map((m) => {
        if (this.my_member != m) {
          this.send(m, 'auth', this.envelope(methodMap('auth')))
        }
      })
    }

    l('Set up sync')
    me.intervals.push(setInterval(sync, K.blocktime * 1000))
  }

  // takes channels with supported hubs (verified and custom ones)
  async channels() {
    var channels = []

    for (var m of K.hubs) {
      if (!me.record || me.record.id != m.id) {
        var ch = await me.getChannel(fromHex(m.pubkey))
        channels.push(ch)
      }
    }

    var deltas = await Delta.findAll()
    for (var d of deltas) {
      if (!K.hubs.find((h) => fromHex(h.pubkey).equals(d.partnerId))) {
        var ch = await me.getChannel(d.partnerId)
        channels.push(ch)
      }
    }

    return channels
  }

  // a generic interface to send a websocket message to some user or member

  send(m, method, tx) {
    tx = concat(inputMap(method), tx)

    // regular pubkey
    if (m instanceof Buffer) {
      if (me.users[m]) {
        me.users[m].send(tx)
        return true
      } else {
        var member = Members.find((f) => f.pubkey.equals(m))
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
      return me.users[m.pubkey].send(tx)
    } else {
      me.users[m.pubkey] = new WebSocketClient()

      me.users[m.pubkey].onmessage = async (tx) => {
        me.addQueue(async () => {
          return RPC.external_rpc(me.users[m.pubkey], bin(tx))
        })
        /*var unlock = await mutex('external_rpc')
        await RPC.external_rpc(me.users[m.pubkey], bin(tx))
        unlock()*/
      }

      me.users[m.pubkey].onerror = function(e) {
        l('Failed to open the socket')
      }
      me.users[m.pubkey].onopen = function(e) {
        if (me.id) {
          me.users[m.pubkey].send(
            concat(inputMap('auth'), me.envelope(methodMap('auth')))
          )
        }

        me.users[m.pubkey].send(tx)
      }

      me.users[m.pubkey].open(m.location)
    }

    return true
  }
}

Me.prototype.consensus = require('./onchain/consensus')
Me.prototype.processBlock = require('./onchain/block')
Me.prototype.processTx = require('./onchain/tx')

Me.prototype.payChannel = require('./offchain/pay_channel')
Me.prototype.flushChannel = require('./offchain/flush_channel')
Me.prototype.getChannel = require('./offchain/get_channel')
Me.prototype.updateChannel = require('./offchain/update_channel')
Me.prototype.ensureAck = require('./offchain/ensure_ack')

module.exports = {
  Me: Me
}
