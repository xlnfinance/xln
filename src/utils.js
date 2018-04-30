// Convenience-first, later globals to be slowly reduced.

// system
assert = require('assert')
fs = require('fs')
http = require('http')
os = require('os')
ws = require('ws')
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

keccak = require('keccak')

nacl = require('../lib/nacl')
ec = (a, b) => bin(nacl.sign.detached(a, b))
ec.verify = nacl.sign.detached.verify

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

trim = (ad) => toHex(ad).substr(0, 4)

logtr = (transitions) => {
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

logstate = (state) => {
  if (!state[1]) return false
  var hash = toHex(sha3(r(state)))

  l(
    `
| ${trim(state[1][0])} | ${trim(state[1][1])} | Hash ${trim(hash)}
------
| #${state[1][2]}  |  ${state[1][3]} | ${state[1][4]}
------
| ${state[2].map((h) => h[0] + '/' + trim(h[1]) + '/' + h[2]).join(', ')} 
------
| ${state[3].map((h) => h[0] + '/' + trim(h[1]) + '/' + h[2]).join(', ')}
`
  )
}

var _orig_console_log = console.log
try {
  // monkey-patch Parcel Logger to avoid cursor jump https://github.com/parcel-bundler/parcel/blob/0d984a563f72798cc0c08e9a27bc0e6e077a0b47/src/Logger.js
  var ParcelLogger = require('parcel-bundler/src/Logger')
  var _orig_parcel_logger_clear = ParcelLogger.clear
  ParcelLogger.clear = () => {
    _orig_parcel_logger_clear.call(ParcelLogger)
    repl.displayPrompt(false) // false = reset cursor
  }
} catch (err) {
  // ignore fails
}

l = (...args) => {
  process.stdout.write('\u001B[2K\u001B[G')
  _orig_console_log(...args)
  if (global.repl) {
    repl.displayPrompt(true)
  }
}

fatal = (reason) => {
  global.repl = null
  l(errmsg(reason))
  process.exit(1)
}

gracefulExit = (comment) => {
  global.repl = null
  l(note(comment))
  process.exit(0)
}

/* Some crazy visualized table log
function() {
  var a = Object.values(arguments)
  console.log.call(console, a)
  cached_result.my_log += a.toString()
}

  var stamp = parseFloat(process.hrtime().join('.')).toFixed(6)
  var str = base_port + ': ' + stamp + ' - ' + a.toString() + '\n'

  var chunks = []
  var chunkSize = 30

  while (str) {
    if (str.length < chunkSize) {
      chunks.push(str)
      break
    } else {
      chunks.push(str.substr(0, chunkSize))
      str = str.substr(chunkSize)
    }
  }

  tolog = '\n\n'

  var pos = [8433, 8001, 8002, 8003].indexOf(base_port)
  if (pos == -1) return false

  chunks.map((ch) => {
    tolog += Array(chunkSize * pos + 1).join(' ') + ch + '\n'
  })

  var path = '/tmp/log',
    buffer = new Buffer(tolog)

  fs.open(path, 'a', function(err, fd) {
    if (err) {
      throw 'error opening file: ' + err
    }

    fs.write(fd, buffer, 0, buffer.length, null, function(err) {
      if (err) throw 'error writing file: ' + err
      fs.close(fd, function() {
        //console.log('file written')
      })
    })
  })
}*/

child_process = require('child_process')

// Amazing lib to forget about binary encoding: https://github.com/ethereum/wiki/wiki/RLP
r = function(a) {
  if (a instanceof Buffer) {
    return rlp.decode(a)
  } else {
    return rlp.encode(a)
  }
}

// for testnet handicaps
sleep = async function(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

current_db_hash = () => {
  return Buffer.alloc(1)
  /* TODO: fix. may cause race condition and lock db for reading breaking other operations
  .from(
    child_process
      .execSync('shasum -a 256 datadir+/onchain/db.sqlite')
      .toString()
      .split(' ')[0],
    'hex'
  )*/
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
bin = (data) => Buffer.from(data)
sha3 = (a) =>
  keccak('keccak256')
    .update(bin(a))
    .digest()

// TODO: not proper alg
kmac = (key, msg) =>
  keccak('keccak256')
    .update(key)
    .update(bin(msg))
    .digest()

ts = () => Math.round(new Date() / 1000)

/*
TODO: Add to test spec - arbitrary number of hops with random fee policy, 
must always correctly guess amount to send for the recipient to get exact invoice amount

fees = [0.0000001, 0.000002, Math.random(), Math.random()]

for(var i = 0; i< 9999999;i++){
  var am = i
  var after = afterFees(beforeFees(i, fees), fees.reverse())

  if (i != after){
    console.log(i, after)
  }

}
*/
beforeFees = (amount, fees) => {
  for (var fee of fees) {
    new_amount = Math.round(amount * (1 + fee))
    if (new_amount == amount) new_amount = amount + K.min_fee
    amount = new_amount
  }

  return new_amount
}
afterFees = (amount, fees) => {
  if (!(fees instanceof Array)) fees = [fees]
  for (var fee of fees) {
    var fee = Math.round(amount / (1 + fee) * fee)
    if (fee == 0) fee = K.min_fee
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

process.title = 'Failsafe'

usage = () => {
  return Object.assign(process.cpuUsage(), process.memoryUsage(), {
    uptime: process.uptime()
  })
}

mutex = async function(key) {
  return new Promise((resolve) => {
    // we resolve from mutex with a fn that fn() unlocks given key
    var unlock = () => {
      resolve(() => mutex.unlock(key))
    }

    if (mutex.queue[key]) {
      l('added to queue ', key)
      mutex.queue[key].push(unlock)
    } else {
      l('init the queue, resolve now ', key)
      mutex.queue[key] = []
      unlock()
    }
  })
}

mutex.queue = {}
mutex.unlock = async function(key) {
  if (!mutex.queue[key]) {
    l('Fail: there was no lock')
  } else if (mutex.queue[key].length > 0) {
    l('shifting from', mutex.queue[key])
    mutex.queue[key].shift()()
  } else {
    l('delete queue', key)
    delete mutex.queue[key]
  }
}

// tells external RPC how to parse this request
inputMap = (i) => {
  var map = [
    'auth', // this socket belongs to my pubkey

    // consensus
    'propose',
    'prevote',
    'precommit',

    'tx', // propose array of tx to add to block

    'sync', // i want to sync since this prev_hash
    'chain', // return X blocks since given prev_hash

    'update', // new input to state machine
    'requestWithdraw',
    'withdrawal',
    'ack',
    'setLimits',

    'testnet'
  ]
  if (typeof i === 'string') {
    // buffer friendly
    return Buffer.from([map.indexOf(i)])
  } else {
    return map[i]
  }
}

// enumerator of all methods and tx types in the system
methodMap = (i) => {
  var map = [
    'placeholder',

    // consensus
    'propose',
    'prevote',
    'precommit',

    // onchain transactions
    'batch', // all transactions are batched one by one

    'withdrawFrom',
    'revealSecrets',
    'disputeWith',
    'depositTo',
    'propose',
    'vote',

    // prefixes to prove it means what it means
    'dispute', // delayed balance proof
    'withdrawal', // instant offchain signature to withdraw from mutual payment channel
    'setLimits',

    // offchain
    'update', // gives ack and 0 or more transitions on top

    'add', // we add hashlock transfer to state.
    'settle', // we've got the secret so please unlock and apply to base offdelta
    'fail', // couldn't get secret for <reason>, delete hashlock

    // same, but off-the-canonical-state
    'addrisk',
    'settlerisk',
    'failrisk',

    'auth' // any kind of offchain auth signatures between peers
  ]

  if (typeof i === 'string') {
    if (map.indexOf(i) == -1) throw 'No such method: ' + i
    return map.indexOf(i)
  } else {
    return map[i]
  }
}
