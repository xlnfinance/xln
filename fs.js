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

ec = (a, b) => bin(nacl.sign.detached(a, b))
ec.verify = nacl.sign.detached.verify

// encoders
BN = require('bn.js')
stringify = require('./lib/stringify')
rlp = require('rlp')

child_process = require('child_process')
const {spawn, exec, execSync} = child_process

Sequelize = require('sequelize')
Op = Sequelize.Op
asyncexec = require('util').promisify(exec)

Me = require('./src/me').Me

// globals
K = false
me = false
Members = false
// Private Key value
PK = {}

RPC = {
  internal_rpc: require('./src/internal_rpc'),
  external_rpc: require('./src/external_rpc')
}

l = console.log

r = function (a) {
  if (a instanceof Buffer) {
    return rlp.decode(a)
  } else {
    return rlp.encode(a)
  }
}


resolveChannel = (insurance, delta, is_left) => {
  var r = {
    promised: 0,
    insured: 0,
    they_insured: 0,
    they_promised: 0
  }
  // three scenarios how delta splits the channel

  if (delta >= 0) {
    r.insured = insurance
    r.they_insured = 0

    r.they_promised = delta
  } else if (delta >= -insurance) {
    r.insured = insurance + delta
    r.they_insured = -delta
  } else {
    r.insured = 0
    r.they_insured = insurance

    r.promised = -(insurance + delta)
  }
  if (!is_left) {
    [r.insured, r.they_insured] = [r.they_insured, r.insured];
    [r.promised, r.they_promised] = [r.they_promised, r.promised];
  }
  return r
}


readInt = (i) => i.length > 0 ? i.readUIntBE(0, i.length) : 0

toHex = (inp) => Buffer.from(inp).toString('hex')
bin = (data) => Buffer.from(data)
sha3 = (a) => keccak('keccak256').update(bin(a)).digest()

// TODO: not proper alg
kmac = (key, msg) => keccak('keccak256').update(key).update(bin(msg)).digest()

ts = () => Math.round(new Date() / 1000)

afterFees = (amount) => {
  var fee = Math.round(amount * K.hub_fee)
  if (fee == 0) fee = K.hub_fee_base
  return amount - fee
}

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

commy = (b, dot = true) => {
  let prefix = b < 0 ? '-' : ''

  b = Math.abs(b).toString()
  if (dot) {
    if (b.length == 1) {
      b = '0.0' + b
    } else if (b.length == 2) {
      b = '0.' + b
    } else {
      var insert_dot_at = b.length - 2
      b = b.slice(0, insert_dot_at) + '.' + b.slice(insert_dot_at)
    }
  }
  return prefix + b.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// trick to pack signed int into unsigned int
packSInt = (num) => (Math.abs(num) * 2) + (num < 0 ? 1 : 0)
readSInt = (num) => {
  num = readInt(num)
  return (num % 2 == 1 ? -(num - 1) / 2 : num / 2)
}

concat = function () {
  return Buffer.concat(Object.values(arguments))
}

process.title = 'Failsafe'

usage = () => {
  return Object.assign(process.cpuUsage(), process.memoryUsage(), {uptime: process.uptime()})
}

// used just for convenience in parsing
inputMap = (i) => {
  // up to 256 input types for websockets
  var map = [
    'tx', // add new tx to block
    'auth', // i am this pubkey in this socket

    'needSig', // member needs sig of others
    'signed',  // other members return sigs of block

    'sync', // i want to sync since this prev_hash
    'chain', // return X blocks since given prev_hash

    'update', // new input to state machine
    'requestWithdraw',
    'withdrawal',
    'ack',
    'setLimits',

    'faucet'
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

    'rebalance',

    'withdrawal', // instant off-chain signature to withdraw from mutual payment channel
    'offdelta',    // delayed balance proof

    'dispute',

    'update',   // transitions to state machine + new sig
    'unlockedPayment', // pay without hashlock
    'ack',
    'setLimits',

    'propose',

    'voteApprove',
    'voteDeny',

    'auth' // any kind of off-chain auth signatures between peers

  ]

  if (typeof i === 'string') {
    if (map.indexOf(i) == -1) throw 'No such method'
    return map.indexOf(i)
  } else {
    return map[i]
  }
}

allowedOnchain = [
  'rebalance',

  'dispute',

  'propose',

  'voteApprove',
  'voteDeny'
]

cache = async (i) => {
  if (K) { // already initialized
    cached_result.is_hub = me.is_hub ? me.my_member.hub.handle : false

    cached_result.my_member = !!me.my_member

    cached_result.K = K



    cached_result.blocks = (await Block.findAll({limit: 100,order: [['id', 'desc']],})).map(b=>{
      var [methodId,
        built_by,
        prev_hash,
        timestamp,
        ordered_tx] = r(b.block.slice(Members.length * 64))

      return {
        prev_hash: toHex(b.prev_hash),
        hash: toHex(b.hash),
        built_by: readInt(built_by),
        timestamp: readInt(timestamp),
        meta: JSON.parse(b.meta)
      }
    })


    if (me.is_hub) {
      cached_result.deltas = []
      cached_result.solvency = 0

      var deltas = await Delta.findAll({where: {myId: me.record.id} })
      var promised = 0
      for (var d of deltas) {
        var ch = await me.channel(d.userId)
        if (ch.delta > 0) promised += ch.promised
      }

      if (cached_result.history[0].delta != promised) {
        cached_result.history.unshift({
          date: new Date(),
          delta: promised
        })
      }
    } else {
      cached_result.history = await History.findAll({
        order: [['id', 'desc']],
        include: {all: true}
      })
    }

    cached_result.proposals = await Proposal.findAll({
      order: [['id', 'DESC']],
      include: {all: true}
    })

    cached_result.users = await User.findAll({include: {all: true}})
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

      var our_location = me.my_member.location.indexOf('0.0.0.0') != -1 ? `http://0.0.0.0:8000/` : `https://failsafe.network/`

      cached_result.install_snippet = `id=fs
f=${filename}
mkdir $id && cd $id && curl ${our_location}$f -o $f

if [[ -x /usr/bin/sha256sum ]] && sha256sum $f || shasum -a 256 $f | grep ${out_hash}; then
  tar -xzf $f && rm $f && ./install

  node fs -p8001
fi`
    })
  }
}

react = async (result = {}, id = 1) => {
  await cache()

  if (me.id) {
    result.record = await me.byKey()

    result.username = me.username // just for welcome message

    result.pubkey = toHex(me.pubkey)

    result.invoices = invoices

    result.channels = await me.channels()
  }

  if (me.browser) {
    me.browser.send(JSON.stringify({
      result: Object.assign(result, cached_result),
      id: id
    }))
  }
}

// now in memory, for simplicity
cached_result = {
  history: [{date: new Date(), delta: 0}]
}

invoices = {}
purchases = {}

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
    } else if (req.url == '/rpc') {
      var queryData = ''
      req.on('data', function (data) { queryData += data })

      req.on('end', function () {
        me.queue.push(['internal_rpc', res, queryData])
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

    // redirecting from http://
    require('http').createServer(function (req, res) {
      res.writeHead(301, { 'Location': 'https://' + req.headers['host'] })
      res.end()
    }).listen(80)
  } else {
    cert = false
    var server = require('http').createServer(cb)
  }

  l('Set up HTTP server at ' + base_port)
  server.listen(base_port).on('error', l)

  me = new Me()
  me.processQueue()

  repl.context.me = me

  if (fs.existsSync('private/pk.json')) {
    PK = JSON.parse(fs.readFileSync('private/pk.json'))
  } else {
    // used to authenticate browser sessions to this daemon
    PK = {
      auth_code: toHex(crypto.randomBytes(32))
    }
  }

  if (argv.username) {
    var seed = await derive(argv.username, argv.pw)
    await me.init(argv.username, seed)
    await me.start()
  } else if (PK.username) {
    await me.init(PK.username, Buffer.from(PK.seed, 'hex'))
    await me.start()
  }

  var url = 'http://0.0.0.0:' + base_port + '/#auth_code=' + PK.auth_code
  l('Open ' + url + ' in your browser')

  // only in desktop
  if (base_port != 443) opn(url)

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
      N: Math.pow(2, 12),
      r: 8,
      p: 1,
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

  assets: Sequelize.TEXT

})

User.idOrKey = async (id) => {
  if (id.length == 32) {
    return (await User.findOrBuild({
      where: {pubkey: id},
      defaults: {
        nonce:0,
        balance:0
      }
    }))[0]
  } else {
    return await User.findById(readInt(id))    
  }
}

Debt = sequelize.define('debt', {
  amount_left: Sequelize.INTEGER,
  oweTo: Sequelize.INTEGER
})


Debt.belongsTo(User)
User.hasMany(Debt)


Proposal = sequelize.define('proposal', {
  desc: Sequelize.TEXT,
  code: Sequelize.TEXT,
  patch: Sequelize.TEXT,

  delayed: Sequelize.INTEGER,

  kindof: Sequelize.STRING
})

Insurance = sequelize.define('insurance', {
  leftId: Sequelize.INTEGER,
  rightId: Sequelize.INTEGER,

  nonce: Sequelize.INTEGER, // for instant withdrawals

  insurance: Sequelize.BIGINT, // insurance
  ondelta: Sequelize.BIGINT, // what hub already insuranceized

  dispute_delayed: Sequelize.INTEGER,
  dispute_nonce: Sequelize.INTEGER,
  dispute_offdelta: Sequelize.INTEGER,
  dispute_left: Sequelize.BOOLEAN
})

Insurance.prototype.resolve = async function(){
  var resolved = resolveChannel(this.insurance, this.ondelta + this.dispute_offdelta, true)

  var left = await User.findById(this.leftId)
  var right = await User.findById(this.rightId)

  this.insurance = 0
  this.dispute_delayed = null
  this.ondelta = -this.dispute_offdelta

  left.balance += resolved.insured
  right.balance += resolved.they_insured

  if (resolved.promised > 0 || resolved.they_promised > 0) {
    var d = await Debt.create({
      userId: resolved.promised > 0 ? left.id : right.id,
      oweTo: resolved.promised > 0 ? right.id : left.id,
      amount_left: resolved.promised > 0 ? resolved.promised : resolved.they_promised
    })
    l(d)
  }

  await left.save()
  await right.save()
  await this.save()
}

Vote = sequelize.define('vote', {
  rationale: Sequelize.TEXT,
  approval: Sequelize.BOOLEAN // approval or denial
})

Proposal.belongsTo(User)

// User.belongsToMany(User, {through: Insurance, as: 'left'})
// User.belongsToMany(User, {through: Insurance, as: 'right'})

Proposal.belongsToMany(User, {through: Vote, as: 'voters'})

// OFF-CHAIN database below:

if (!fs.existsSync('private')) fs.mkdirSync('private')

base_db.storage = 'private/db.sqlite'
privSequelize = new Sequelize('', '', 'password', base_db)

Block = privSequelize.define('block', {
  block: Sequelize.CHAR.BINARY,
  hash: Sequelize.CHAR(32).BINARY,
  prev_hash: Sequelize.CHAR(32).BINARY,
  meta: Sequelize.TEXT
})



Delta = privSequelize.define('delta', {
  // between who and who
  myId: Sequelize.CHAR(32).BINARY,
  partnerId: Sequelize.CHAR(32).BINARY,

  // higher nonce is valid
  nonce: Sequelize.INTEGER,

  instant_until: Sequelize.INTEGER,

  // Three most important values that define balances of each other
  insurance: Sequelize.INTEGER,
  ondelta: Sequelize.INTEGER,
  offdelta: Sequelize.INTEGER,

  we_soft_limit: Sequelize.INTEGER,
  we_hard_limit: Sequelize.INTEGER, // usually 0

  they_soft_limit: Sequelize.INTEGER,
  they_hard_limit: Sequelize.INTEGER, // user specified risk

  last_online: Sequelize.DATE,

  they_input_amount: Sequelize.INTEGER,

  our_input_amount: Sequelize.INTEGER,
  our_input_sig: Sequelize.TEXT,

  hashlocks: Sequelize.TEXT,

  // all channels in serialized field
  state: {
    type: Sequelize.TEXT,
    set (val) {
      stringify(this.setDataValue('state'))
    },
    get (val) {
      return parse(this.getDataValue('state'))
    }
  },

  sig: Sequelize.TEXT,

  status: Sequelize.TEXT,

// history
  amount: Sequelize.INTEGER,
  balance: Sequelize.INTEGER,
  desc: Sequelize.TEXT,
  date: Sequelize.DATE
})

Delta.prototype.getState = function () {
  var compared = Buffer.compare(this.myId, this.partnerId)

  return r([methodMap('offdelta'),
    compared==-1?this.myId:this.partnerId,
    compared==-1?this.partnerId:this.myId,
    this.nonce,
    packSInt(this.offdelta)])
}

History = privSequelize.define('history', {
  leftId: Sequelize.CHAR(32).BINARY,
  rightId: Sequelize.CHAR(32).BINARY,

  date: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
  delta: Sequelize.INTEGER,

  amount: Sequelize.INTEGER,
  balance: Sequelize.INTEGER,
  desc: Sequelize.TEXT,


})

Purchase = privSequelize.define('purchase', {
  myId: Sequelize.CHAR(32).BINARY,
  partnerId: Sequelize.INTEGER,

  delta: Sequelize.INTEGER,

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
    me.send(Members[0], 'sync', Buffer.from(K.prev_hash, 'hex'))
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

var argv = require('minimist')(process.argv.slice(2), {
  string: ['username', 'pw']
})

base_port = argv.p ? parseInt(argv.p) : 8000;

(async () => {
  if (argv.console) {

  } else if (process.argv[2] == 'city') {
    city()
  } else if (argv.genesis) {
    require('./src/genesis')(argv.genesis)
  } else {
    if (fs.existsSync('data/k.json')) {
      l('Loading K data')
      var json = fs.readFileSync('data/k.json')
      K = JSON.parse(json)

      Members = JSON.parse(json).members // another object ref
      for (m of Members) {
        m.pubkey = Buffer.from(m.pubkey, 'hex')
        m.block_pubkey = Buffer.from(m.block_pubkey, 'hex')
      }
    }

    await privSequelize.sync({force: false})

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
})()

process.on('unhandledRejection', r => console.log(r))

repl = require('repl').start('> ')
_eval = repl.eval
repl.eval = (cmd, context, filename, callback) => {
  if (cmd.indexOf('await') != -1) cmd = `(function(){ async function _wrap() { console.log(${cmd}) } return _wrap() })()`
  _eval(cmd, context, filename, callback)
}
