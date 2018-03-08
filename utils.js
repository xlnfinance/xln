
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


Sequelize = require('sequelize')
Op = Sequelize.Op

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

// tells external RPC how to parse this request (256 options)
inputMap = (i) => {
  var map = [
    'auth', // this socket belongs to my pubkey

    // consensus
    'needSig', // member needs sig of others
    'signed',  // other members return sigs of block

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
