#!/usr/bin/env node

// system
assert = require('assert')
fs = require('fs')
http = require('http')
os = require('os')
ws = require('ws')
opn = require('./lib/opn')

// crypto
crypto = require('crypto')
// scrypt = require('scrypt') // require('./scrypt_'+os.platform())

keccak = require('keccak')
nacl = require('./lib/nacl')

ec = (a,b) => bin(nacl.sign.detached(a,b))
ec.verify = nacl.sign.detached.verify

// encoders
BN = require('bn.js')
stringify = require('./lib/stringify')
rlp = require('rlp')

base_port = process.argv[2] ? parseInt(process.argv[2]) : 8000

child_process = require('child_process')
const {spawn, exec, execSync} = child_process

Sequelize = require('sequelize')
Op = Sequelize.Op
asyncexec = require('util').promisify(exec)

Me = require('./src/me').Me

l = console.log
d = l // ()=>{}

r = function (a) {
  if (a instanceof Buffer) {
    return rlp.decode(a)
  } else {
    return rlp.encode(a)
  }
}

readInt = (i) => i.readUIntBE(0, i.length)

toHex = (inp) => Buffer.from(inp).toString('hex')
bin = (data) => Buffer.from(data)
sha3 = (a) => keccak('keccak256').update(bin(a)).digest()

// TODO: not proper alg
kmac = (key, msg) => keccak('keccak256').update(key).update(bin(msg)).digest()

ts = () => Math.round(new Date() / 1000)

parse = (json) => {
  try {
    var o = JSON.parse(json)
    if (o && typeof o === 'object') {
      return o
    }
  } catch (e) {
    return {}
  }
}


// trick to pack signed int into unsigned int
packSInt = (num) => (Math.abs(num) * 2) + (num < 0 ? 1 : 0)
readSInt = (num) => (num % 2 == 1 ? -(num-1)/2 : num/2)




concat = function () {
  return Buffer.concat(Object.values(arguments))
}

// used to authenticate browser sessions to this daemon
auth_code = toHex(crypto.randomBytes(32))
process.title = 'Failsafe'

usage = () => {
  return Object.assign(process.cpuUsage(), process.memoryUsage(), {uptime: process.uptime()})
}

// used just for convenience in parsing
inputMap = (i) => {
  // up to 256 input types for websockets
  var map = [
    'tx', 'auth', 'needSig', 'signed',
    'block', 'chain', 'sync',
    'mediate', 'receive', 'faucet'
  ]
  if (typeof i === 'string') {
    // buffer friendly
    return Buffer([map.indexOf(i)])
  } else {
    return map[i]
  }
}

// enumerator of all methods and tx types in the system
methodMap = (i) => {
  var map = [
    'placeholder',

    'block',

    'rebalanceHub',
    'rebalanceUser',

    'withdraw', // instant off-chain signature to withdraw from mutual payment channel
    'delta',    // delayed balance proof

    'propose',

    'voteApprove',
    'voteDeny',

    'auth', // any kind of off-chain auth signatures between peers

    'fsd',
    'fsb'
  ]

  if (typeof i === 'string') {
    // buffer friendly
    assert(map.indexOf(i) != -1, 'No such method')
    return map.indexOf(i)
  } else {
    return map[i]
  }
}

allowedOnchain = [
  'rebalanceHub',
  'rebalanceUser',

  'propose',

  'voteApprove',
  'voteDeny'
]

// onchain Key value
K = false
// Private Key value
PK = {}

loadJSON = () => {
  if (fs.existsSync('data/k.json')) {
    l('Loading K')
    var json = fs.readFileSync('data/k.json')
    K = JSON.parse(json)

    me.K = K
    me.members = JSON.parse(json).members // another object ref

    me.members.map(f => {
      f.pubkey = Buffer.from(f.pubkey, 'hex')
      f.block_pubkey = Buffer.from(f.block_pubkey, 'hex')
    })
  }
}

trustlessInstall = async a => {
  tar = require('tar')
  var filename = 'Failsafe-' + K.total_blocks + '.tar.gz'
  l('generating install ' + filename)
  tar.c({
    gzip: true,
  		portable: true,
    file: 'private/' + filename,
    filter: (path, stat) => {
      stat.mtime = null // must be deterministic
        // disable /private (blocks sqlite, proofs, local config) allow /default_private
      if (path.match(/(\.DS_Store|private|node_modules|test)/)) {
          // l('skipping '+path)
        return false
      }
      return true
    }
  },
    ['.']
  ).then(_ => {
    l('Snapshot made: ' + filename)
  })
}

cached_result = {}

cache = async (i) => {
  if (K) { // already initialized
    cached_result.is_hub = me.is_hub

    cached_result.my_member = !!me.my_member

    cached_result.K = K

    if (me.is_hub) {
      var h = require('./src/hub')
      h = await h()
      cached_result.deltas = h.channels
      cached_result.solvency = h.solvency
    }

    cached_result.proposals = await Proposal.findAll({
      order: [['id', 'DESC']],
      include: {all: true}
    })

    cached_result.users = await User.findAll({include: {all: true}})

    cached_result.history = await History.findAll({
      order: [['id', 'desc']],
      include: {all: true}
    })
  }

  if (me.my_member && K.last_snapshot_height) {
    var filename = `Failsafe-${K.last_snapshot_height}.tar.gz`
    var cmd = 'shasum -a 256 private/' + filename

    exec(cmd, async (er, out, err) => {
      if (out.length == 0) {
        l('This state doesnt exist')
        return false
      }

      var out_hash = out.split(' ')[0]

      var our_location = me.my_member.location == 'ws://0.0.0.0:8000' ? `http://0.0.0.0:8000/` : `https://failsafe.network/`

      cached_result.install_snippet = `id=fs
f=${filename}
mkdir $id && cd $id && curl ${our_location}$f -o $f

if [[ -x /usr/bin/sha256sum ]] && sha256sum $f || shasum -a 256 $f | grep ${out_hash}; then
  tar -xzf $f && rm $f && ./install && node fs.js 8001
fi`
    })
  }
}

react = async (result = {}, id = 1) => {
  await cache()

  if (me.id) {
    result.record = await me.byKey()

    result.username = me.username // just for welcome message

    result.pubkey = toHex(me.id.publicKey)

    if (!me.is_hub) result.ch = await me.channel(1)
  }

  if (me.browser) {
    me.browser.send(JSON.stringify({
      result: Object.assign(result, cached_result),
      id: id
    }))
  }
}

me = false
invoices = {}

initDashboard = async a => {
  var finalhandler = require('finalhandler')
  var serveStatic = require('serve-static')

  var cb = function (req, res) {
    if (req.url.match(/^\/Failsafe-([0-9]+)\.tar\.gz$/)) {
      var file = 'private' + req.url
      var stat = fs.statSync(file)
      res.writeHeader(200, {'Content-Length': stat.size})
      var fReadStream = fs.createReadStream(file)
      fReadStream.on('data', function (chunk) {
        if (!res.write(chunk)) {
          fReadStream.pause()
        }
      })
      fReadStream.on('end', function () {
        res.end()
      })
      res.on('drain', function () {
        fReadStream.resume()
      })
    } else if (req.url == '/invoice') {
      var queryData = ''
      req.on('data', function (data) { queryData += data })

      req.on('end', function () {
        queryData = parse(queryData)

        if (queryData.invoice) {
          // deep clone
          var result = Object.assign({}, invoices[queryData.invoice])

          // prevent race condition attack
          if (invoices[queryData.invoice].status == 'paid') { invoices[queryData.invoice].status = 'archive' }
        } else {
          var invoice = toHex(crypto.randomBytes(32))

          invoices[invoice] = {
            amount: parseInt(queryData.amount),
            assetType: parseInt(queryData.assetType),
            status: 'pending'
          }

          var result = {
            invoice: invoice,
            recipient: toHex(me.id.publicKey),
            hubId: 1,
            amount: invoices[invoice].amount,
            status: 'pending'
          }
        }

        res.end(JSON.stringify(result))
      })
    } else {
      serveStatic('./wallet')(req, res, finalhandler(req, res))
    }
  }

  // this serves dashboard HTML page

  var on_server = fs.existsSync('/etc/letsencrypt/live/failsafe.network/fullchain.pem')

  if (on_server) {
    cert = {
      cert: fs.readFileSync('/etc/letsencrypt/live/failsafe.network/fullchain.pem'),
      key: fs.readFileSync('/etc/letsencrypt/live/failsafe.network/privkey.pem')
    }
    var server = require('https').createServer(cert, cb)
    base_port = 443
  } else {
    cert = false
    var server = require('http').createServer(cb)
  }

  l('Set up HTTP server at ' + base_port)
  server.listen(base_port).on('error', l)

  var url = 'http://0.0.0.0:' + base_port + '/#auth_code=' + auth_code
  l('Open ' + url + ' in your browser')

  // only in desktop
  if (base_port != 443) opn(url)

  me = new Me()
  me.processQueue()



  loadJSON()

  setTimeout(async () => {
    // auto login
    if (fs.existsSync('private/pk.json')) {
      PK = JSON.parse(fs.readFileSync('private/pk.json'))
      l('auto login')

      await me.init(PK.username, Buffer.from(PK.seed, 'hex'))
      await me.start()
    }
  }, 200)



  localwss = new ws.Server({ server: server, maxPayload: 64 * 1024 * 1024 })

  localwss.on('error', function (err) { console.error(err) })
  localwss.on('connection', function (ws) {
    ws.on('message', (msg) => {
      me.queue.push(['internal_rpc', ws, msg]) 
    })
  })
}

derive = async (username, pw) => {
  return new Promise((resolve, reject) => {
    require('./lib/scrypt')(pw, username, {
      N: Math.pow(2, 16),
      r: 8,
      p: 2,
      dkLen: 32,
      encoding: 'binary'
    }, (r) => {
      r = bin(r)

      // l(`Derived ${r.toString('hex')} for ${username}:${pw}`)

      resolve(r)
    })

/*
    var seed = await scrypt.hash(pw, {
      N: Math.pow(2, 16),
      interruptStep: 1000,
      p: 2,
      r: 8,
      dkLen: 32,
      encoding: 'binary'
    }, 32, username)

    return seed; */
  })
}

// this is onchain database - shared among everybody
var base_db = {
  dialect: 'sqlite',
  // dialectModulePath: 'sqlite3',
  storage: 'data/db.sqlite',
  define: {timestamps: false},
  operatorsAliases: false,
  logging: false
}

sequelize = new Sequelize('', '', 'password', base_db)

// two kinds of storage: 1) critical database that might be used by code
// 2) complementary stats like updatedAt that's useful in exploring and can be deleted safely

User = sequelize.define('user', {
  username: Sequelize.STRING,

  pubkey: Sequelize.CHAR(32).BINARY,

  nonce: Sequelize.INTEGER,
  balance: Sequelize.BIGINT, // mostly to pay taxes
  fsb_balance: Sequelize.BIGINT // standalone bond 2030

})

Proposal = sequelize.define('proposal', {
  desc: Sequelize.TEXT,
  code: Sequelize.TEXT,
  patch: Sequelize.TEXT,

  delayed: Sequelize.INTEGER,

  kindof: Sequelize.STRING
})

Insurance = sequelize.define('insurance', {
  nonce: Sequelize.INTEGER, // for instant withdrawals

  insurance: Sequelize.BIGINT, // insurance
  rebalanced: Sequelize.BIGINT, // what hub already insuranceized

  assetType: Sequelize.INTEGER,

  delayed: Sequelize.INTEGER,
  dispute_is_hub: Sequelize.BOOLEAN, // was it started by hub or user?
  dispute_delta: Sequelize.INTEGER

})

Vote = sequelize.define('vote', {
  rationale: Sequelize.TEXT,
  approval: Sequelize.BOOLEAN // approval or denial
})

// promises

Proposal.belongsTo(User)

User.belongsToMany(User, {through: Insurance, as: 'hub'})

Proposal.belongsToMany(User, {through: Vote, as: 'voters'})

// this is off-chain private database for blocks and other balance proofs
// for things that new people don't need to know and can be cleaned up

if (!fs.existsSync('private')) fs.mkdirSync('private')

base_db.storage = 'private/db.sqlite'
privSequelize = new Sequelize('', '', 'password', base_db)

Block = privSequelize.define('block', {
  block: Sequelize.CHAR.BINARY,
  hash: Sequelize.CHAR(32).BINARY,
  prev_hash: Sequelize.CHAR(32).BINARY
})

// stored signed deltas
Delta = privSequelize.define('delta', {
  userId: Sequelize.CHAR(32).BINARY,
  hubId: Sequelize.INTEGER,

  sig: Sequelize.TEXT,

  nonce: Sequelize.INTEGER,

  instant_until: Sequelize.INTEGER,

  delta: Sequelize.INTEGER,

// history
  amount: Sequelize.INTEGER,
  balance: Sequelize.INTEGER,
  desc: Sequelize.TEXT,
  date: Sequelize.DATE
}, {
  instanceMethods: {
    getState: function(counterparty) {
      let negative = ch.delta_record.delta < 0 ? 1 : null

      return [methodMap('delta'), 
        counterparty, 
        this.nonce, 
        negative, 
        (negative ? -this.delta : this.delta), 
        ts()]
    }
  }
})

History = privSequelize.define('history', {
  userId: Sequelize.CHAR(32).BINARY,
  hubId: Sequelize.INTEGER,

  rdelta: Sequelize.INTEGER,

  amount: Sequelize.INTEGER,
  balance: Sequelize.INTEGER,
  desc: Sequelize.TEXT,

  date: { type: Sequelize.DATE, defaultValue: Sequelize.NOW }

})

Event = privSequelize.define('event', {
  data: Sequelize.CHAR.BINARY,
  kindof: Sequelize.STRING,
  p1: Sequelize.STRING
})

sync = () => {
  if (K.prev_hash) {
    me.send(K.members[0], 'sync', Buffer.from(K.prev_hash, 'hex'))
  }
}

city = async () => {
  var u = []
  for (var i = 0; i < 1000; i++) {
    u[i] = new Me()
    var b = Buffer.alloc(32)
    b.writeInt32BE(i)
    u[i].init('u' + i, b)
  }

  l('Ready')
}

if (process.argv[2] == 'console') {

} else if (process.argv[2] == 'city') {
  city()
} else if (process.argv[2] == 'genesis') {
  require('./src/genesis')({location: process.argv[3]})
} else if (process.argv[2] == 'login') {
  setTimeout(async () => {
    var me = new Me()
    me.processQueue()

    var seed = await derive(process.argv[3], process.argv[4])
    await me.init(process.argv[3], seed)
  }, 100)
} else {
  privSequelize.sync({force: false})

  /*
  var cluster = require('cluster')
  if (cluster.isMaster) {
    cluster.fork();

    cluster.on('exit', function(worker, code, signal) {
      console.log('exit')
      //cluster.fork();
    });
  }

  if (cluster.isWorker) { */
  initDashboard()
  // }
}

process.on('unhandledRejection', r => console.log(r))

require('repl').start('> ')
