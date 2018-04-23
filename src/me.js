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

    this.record = await this.byKey()

    PK.username = username
    PK.seed = seed.toString('hex')
    fs.writeFileSync('private/pk.json', JSON.stringify(PK))
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
    }, 10)
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

  async broadcast(method, args) {
    me.record = await me.byKey()

    switch (method) {
      case 'rebalance':
        l('Broadcasted rebalance ', r(args))

        break

      case 'propose':
        if (args[0].length <= 1) throw 'Rationale is required'

        if (args[2]) {
          // diff -urB . ../yo
          args[2] = fs.readFileSync('../' + args[2])
        }

        args = r(args)
        break
    }

    var nonce = me.record.nonce + PK.pending_tx.length

    var to_sign = r([methodMap(method), nonce, args])

    var tx = r([
      me.record.id,
      ec(to_sign, me.id.secretKey),
      methodMap(method),
      nonce,
      args
    ])

    PK.pending_tx.push({
      method: method,
      raw: toHex(tx)
    })

    if (me.my_member && me.my_member == me.next_member()) {
      me.mempool.push(tx)
    } else {
      me.send(me.next_member(), 'tx', r([tx]))
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
    this.intervals.push(setInterval(cache, 2000))

    if (this.my_member) {
      me.consensus() // 1s intervals

      // there's 2nd dedicated websocket server for member/hub commands
      var cb = () => {}
      me.member_server = cert
        ? require('https').createServer(cert, cb)
        : require('http').createServer(cb)
      me.member_server.listen(parseInt(this.my_member.location.split(':')[2]))

      l('Bootstrapping local server at: ' + this.my_member.location)

      me.wss = new ws.Server({
        server: me.member_server,
        maxPayload: 64 * 1024 * 1024
      })

      me.wss.on('error', function(err) {
        console.error(err)
      })
      me.wss.on('connection', function(ws) {
        ws.on('message', async (msg) => {
          me.queue.push(async () => {
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

      if (this.my_hub) {
        me.intervals.push(
          setInterval(require('./offchain/rebalance'), K.blocktime * 1000)
        )
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
        this.queue.push(async () => {
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

Me.prototype.flushChannel = require('./offchain/flush_channel')
Me.prototype.getChannel = require('./offchain/get_channel')
Me.prototype.updateChannel = require('./offchain/update_channel')

module.exports = {
  Me: Me
}
