// Convenience-first, later globals to be slowly reduced.

// system
assert = require('assert')
fs = require('fs')
http = require('http')
os = require('os')
ws = require('ws')
querystring = require('querystring')
opn = require('../lib/opn')

var chalk = require('chalk') // pretty logs?
highlight = (text) => `"${chalk.bold(text)}"`
link = (text) => `${chalk.underline.white.bold(text)}`
errmsg = (text) => `${chalk.red('   [Error]')} ${text}`
note = (text) => `${chalk.gray(`  ⠟ ${text}`)}`

// crypto TODO: native version
crypto = require('crypto')
// scrypt = require('scrypt') // require('./scrypt_'+os.platform())
base58 = require('base-x')(
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
)

nacl = require('../lib/nacl')

encrypt_box = nacl.box
open_box = nacl.box.open

ec = (a, b) => bin(nacl.sign.detached(a, b))
ec.verify = nacl.sign.detached.verify

/*
ec = (a, b) => concat(Buffer.alloc(32), sha3(a))
ec.verify = (a, b, c) => ec(a).equals(b)
*/

// promisify writeFile
promise_writeFile = require('util').promisify(fs.writeFile)

// encoders
BN = require('bn.js')
stringify = require('../lib/stringify')
rlp = require('../lib/rlp') // patched rlp for signed-integer

Sequelize = require('sequelize')
Op = Sequelize.Op

Me = require('./me').Me

// globals
K = false
me = false
Members = false
// Private Key value
PK = {}

RPC = {
  internal_rpc: require('./internal_rpc'),
  external_rpc: require('./external_rpc')
}

// it's just handier when Buffer is stringified into hex vs Type: Buffer..
Buffer.prototype.toJSON = function() {
  return this.toString('hex')
}

prettyState = (state) => {
  if (!state[1]) return false
  state[1][2] = readInt(state[1][2])
  state[1][3] = readInt(state[1][3])
  state[1][4] = readInt(state[1][4])

  // amount and exp, except the hash
  state[2].map((h) => {
    h[0] = readInt(h[0])
    h[2] = readInt(h[2])
  })

  state[3].map((h) => {
    h[0] = readInt(h[0])
    h[2] = readInt(h[2])
  })
}

parseAddress = (addr) => {
  addr = addr.toString()
  if (addr.includes('#')) {
    // the invoice is encoded as #hash in destination and takes precedence over manually sent invoice
    var [addr, invoice] = addr.split('#')
  }

  var parts = r(base58.decode(addr))

  return {
    box_pubkey: parts[0],
    pubkey: parts[1],
    hubs: parts[2] ? parts[2].map(readInt) : [1],
    invoice: invoice
  }
}


trim = (ad) => toHex(ad).substr(0, 4)

logstates = (a, b, c, d) => {
  l('Our state\n', ascii_state(a))
  l('Our signed state\n', ascii_state(b))
  l('Their state\n', ascii_state(c))
  l('Their signed state\n', ascii_state(d))
}
ascii_state = (state) => {
  if (!state[1]) return false
  let hash = toHex(sha3(r(state)))

  let locks = (hl) => {
    return hl
      .map((h) => h[0] + '/' + (h[1] ? trim(h[1]) : 'N/A') + '/' + h[2])
      .join(', ')
  }

  return `Hash ${trim(hash)} | ${trim(state[1][0])}-${trim(state[1][1])} | #${
    state[1][2]
  } | ${state[1][3]} | \$${state[1][4]}
-----
+${locks(state[2])}
-----
-${locks(state[3])}
`
}

ascii_tr = (transitions) => {
  try {
    for (var t of transitions) {
      var m = methodMap(readInt(t[0]))

      if (m == 'add') {
        var info = `add ${readInt(t[1][0])} ${trim(t[1][1])} ${readInt(
          t[1][2]
        )} ${trim(t[1][3])}`
      } else {
        var info = `${m} ${trim(t[1][1])}`
      }
      l(`${info}`)
    }
  } catch (e) {}
}

l = (...args) => {
  console.log(...args)
}

wscb = (...args) => {
  //console.log("Received from websocket ", args)
}

// offchain logs
loff = (text) => l(`${chalk.green(`       ⠟ ${text}`)}`)

fatal = (reason) => {
  global.repl = null
  l(errmsg(reason))

  if (me) {
    react({reload: true}) //reloads UI window
    me.intervals.map(clearInterval)

    me.syncdb().then(async () => {
      //await sequelize.close()
      //await privSequelize.close()
      await sleep(500)

      process.exit()
    })
  }
}

gracefulExit = (comment) => {
  global.repl = null
  l(note(comment))
  process.exit(0)
}

child_process = require('child_process')

// error-ignoring wrapper around https://github.com/ethereum/wiki/wiki/RLP
r = function(a) {
  if (a instanceof Buffer) {
    try {
    return rlp.decode(a)
    }catch(e){ return []; }
  } else {
    try{
    return rlp.encode(a)
    }catch(e){return new Buffer([]) }
  }
}

// for testnet handicaps
sleep = async function(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

var {performance} = require('perf_hooks')

// critical section for "key"
q = async function(key, job) {
  return new Promise(async (resolve) => {
    key = 'key_' + JSON.stringify(key)

    if (q.q[key]) {
      q.q[key].push([job, resolve])
    } else {
      q.q[key] = [[job, resolve]]

      while (q.q[key].length > 0) {
        try {
          let [got_job, got_resolve] = q.q[key].shift()
          let started = performance.now()

          //let deadlock = setTimeout(function() {
          //  fatal('Deadlock in q ' + key)
          //}, 20000)

          got_resolve(await got_job())

          //clearTimeout(deadlock)
          //l('Section took: ' + (performance.now() - started))
        } catch (e) {
          l("Error in q", e)
          setTimeout(() => {
            fatal(e)
          }, 100)
        }
      }
      delete q.q[key]
    }
  })
}
q.q = {}

current_db_hash = () => {
  return Buffer.alloc(1)
  /* TODO: fix. may cause race condition and lock db for reading breaking other operations

    var out = child_process.execSync(`shasum -a 256 ${datadir}/onchain/db*`).toString().split(/[ \n]/)
    return fromHex(out)
   */
}

localhost = '127.0.0.1'

readInt = (i) => {
  // reads signed integer from RLP encoded buffer

  if (i.length > 0) {
    var num = i.readUIntBE(0, i.length)
    return num % 2 == 1 ? -(num - 1) / 2 : num / 2
  } else {
    return 0
  }
}

toHex = (inp) => Buffer.from(inp).toString('hex')
fromHex = (inp) => Buffer.from(inp, 'hex')
bin = (data) => {
  if (data instanceof ArrayBuffer) {
    //Buffer.from(arrayBuffer: This creates a view of the ArrayBuffer without copying the underlying memory
    //Buffer.from(buffer): Copies the passed buffer data onto a new Buffer instance

    return Buffer.from(Buffer.from(data))
  } else if (data instanceof Buffer) {
    return data
  } else {
    return Buffer.from(typeof data == 'number' ? [data] : data)
  }
}

/*
sha3 = (a) =>
  crypto
    .createHash('sha256')
    .update(bin(a))
    .digest()
*/
js_sha3 = require('js-sha3')
sha3 = (a) => bin(js_sha3.sha3_256.digest(bin(a)))

ts = () => Math.round(new Date() / 1000)

beforeFees = (amount, fees) => {
  for (var fee of fees) {
    new_amount = Math.round(amount * (1 + fee))
    if (new_amount == amount) new_amount = amount + K.min_fee
    if (new_amount > amount + K.max_fee) new_amount = amount + K.max_fee
    amount = new_amount
  }

  return new_amount
}
afterFees = (amount, fees) => {
  if (!(fees instanceof Array)) fees = [fees]
  for (var fee of fees) {
    var fee = Math.round(amount / (1 + fee) * fee)
    if (fee == 0) fee = K.min_fee
    if (fee > K.max_fee) fee = K.max_fee
    amount = amount - fee
  }
  return amount
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

concat = function() {
  return Buffer.concat(Object.values(arguments))
}

usage = () => {
  return Object.assign(process.cpuUsage(), process.memoryUsage(), {
    uptime: process.uptime()
  })
}

// enumerator of all methods and tx types in the system
methodMap = (i) => {
  let methodMap = [
    'placeholder',

    // consensus
    'propose', // same word used to propose amendments
    'prevote',
    'precommit',

    // onchain transactions
    'batch', // all transactions are batched one by one

    // methods below are per-assets (ie should have setAsset directive beforehand)
    'setAsset',
    'disputeWith', // defines signed state (balance proof). Used only as last resort!
    'withdrawFrom', // mutual *instant* withdrawal proof. Used during normal cooperation.
    'depositTo', // send money to some channel or user

    // onchain exchange
    'createOrder',
    'cancelOrder',

    'createAsset',
    'createHub',

    'revealSecrets', // reveal secrets if partner has not acked our del settle
    'vote',

    // offchain
    'update', // gives ack and 0 or more transitions on top

    'setLimits', // define credit limits to partner

    'add', // we add hashlock transfer to state.
    'del', // we've got the secret or couldn't get secret for <reason>

    // same, but off-canonical-state and risky (receiver is not required to return secret to claim money)
    'addrisk',
    'delrisk',

    // fail reasons
    'failOffline',
    'failNoCapacity',

    // offchain inputs
    'auth', // any kind of offchain auth signatures between partners
    'tx', // propose array of tx to add to block
    'sync', // i want to sync since this prev_hash
    'chain', // return X blocks since given prev_hash
    'requestWithdrawFrom',
    'ack',
    'testnet'
  ]

  if (typeof i === 'string') {
    i = i.trim()
    if (methodMap.indexOf(i) == -1) throw `No such method: "${i}"`
    return methodMap.indexOf(i)
  } else {
    return methodMap[i]
  }
}
