// Convenience-first, later globals to be slowly reduced.

// system
assert = require('assert')
fs = require('fs')
http = require('http')
os = require('os')
ws = require('ws')
opn = require('../lib/opn')

chalk = require('chalk') // pretty logs?

// crypto TODO: native version
crypto = require('crypto')
// scrypt = require('scrypt') // require('./scrypt_'+os.platform())

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
  state[3] = readInt(state[3])
  state[4] = readInt(state[4])

  state[5].map((h) => {
    h[0] = readInt(h[0])
    h[2] = readInt(h[2])
  })

  state[6].map((h) => {
    h[0] = readInt(h[0])
    h[2] = readInt(h[2])
  })
}

logstate = (state) => {
  l(
    `Nonce #${state[3]} delta ${state[4]} locks ${state[5].length} / ${
      state[6].length
    }`
  )
}
l = function() {
  //var str =
  var stamp = parseFloat(process.hrtime().join('.')).toFixed(6)
  var a = Object.values(arguments)
  console.log.call(console, a)

  var str = base_port + ': ' + stamp + ' - ' + stringify(a) + '\n'
  cached_result.my_log += str

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
}

//console.log

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
  return Buffer([])
  /* TODO: fix. may cause race condition and lock db for reading breaking other operations
  .from(
    child_process
      .execSync('shasum -a 256 data/db.sqlite')
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
var min_fee = 0
beforeFees = (amount, fees) => {
  for (var fee of fees) {
    new_amount = Math.round(amount * (1 + fee))
    if (new_amount == amount) new_amount = amount + min_fee
    amount = new_amount
  }

  return new_amount
}
afterFees = (amount, fees) => {
  if (!(fees instanceof Array)) fees = [fees]
  for (var fee of fees) {
    var fee = Math.round(amount / (1 + fee) * fee)
    if (fee == 0) fee = min_fee
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
    return Buffer([map.indexOf(i)])
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

    'rebalance',
    'propose',
    'vote',

    'offdelta', // delayed balance proof
    'dispute', // delayed balance proof

    // state machine transitions, sent peer to peer off-chain
    'withdrawal', // instant off-chain signature to withdraw from mutual payment channel

    'update',
    'ack',
    'setLimits',

    'requestMaster',
    'grantMaster',

    // 10,[] => 15,[] - add directly to base offdelta
    'add',

    // 15,[] => 15,[] - (NOT STATE CHANGING) offdelta remains the same, there was no hashlock
    'settle',

    // 15,[] => 10,[] - secret not found, offdelta is decreased voluntarily
    'fail',

    // 10,[] => 10,[[5,H1,E1]]
    'addlock', // we add hashlock transfer to state.

    // 10,[[5,H1,E1]] => 15,[]
    'settlelock', // we've got the secret so please unlock and apply to base offdelta

    // 10,[[5,H1,E1]] => 10,[]
    'faillock', // couldn't get secret for <reason>, delete hashlock

    'auth' // any kind of off-chain auth signatures between peers
  ]

  if (typeof i === 'string') {
    if (map.indexOf(i) == -1) throw 'No such method'
    return map.indexOf(i)
  } else {
    return map[i]
  }
}

allowedOnchain = ['rebalance', 'batch', 'propose', 'vote']
