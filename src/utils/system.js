// Convenience-first, later globals to be slowly reduced.
Periodical = require('../periodical')

// system
assert = require('assert')
fs = require('fs')
http = require('http')
os = require('os')
ws = require('ws')
querystring = require('querystring')
opn = require('../../lib/opn')

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

// shorter way to find by asset
Array.prototype.by = function(attr, val) {
  return this.find((obj) => {
    return obj[attr] === val
  })
}

nacl = require('../../lib/nacl')

encrypt_box = nacl.box
open_box = nacl.box.open

// more highlevel wrappers that operate purely with JSON
encrypt_box_json = (box_data, target_pubkey) => {
  // we don't care about authentication of box, but nacl requires that
  let throwaway = nacl.box.keyPair()

  let unlocker_nonce = crypto.randomBytes(24)

  let box = encrypt_box(
    bin(JSON.stringify(box_data)),
    unlocker_nonce,
    target_pubkey,
    throwaway.secretKey
  )
  return r([bin(box), unlocker_nonce, bin(throwaway.publicKey)])
}

open_box_json = (box) => {
  let unlocker = r(box)
  let raw_box = open_box(
    unlocker[0],
    unlocker[1],
    unlocker[2],
    me.box.secretKey
  )
  if (raw_box == null) {
    return false
  } else {
    return parse(bin(raw_box).toString())
  }
}

ec = (a, b) => bin(nacl.sign.detached(a, b))
ec.verify = (a, b, c) => {
  me.metrics.ecverify.current++

  // speed of ec.verify is useless in benchmarking as depends purely on 3rd party lib speed
  return argv.nocrypto ? true : nacl.sign.detached.verify(a, b, c)
}

/*
ec = (a, b) => concat(Buffer.alloc(32), sha3(a))
ec.verify = (a, b, c) => ec(a).equals(b)
*/

// promisify writeFile
promise_writeFile = require('util').promisify(fs.writeFile)

// encoders
BN = require('bn.js')
stringify = require('../../lib/stringify')
rlp = require('../../lib/rlp') // patched rlp for signed-integer

Sequelize = require('sequelize')
Op = Sequelize.Op

// globals
K = false
me = false
Validators = false
// Private Key value
PK = {}

RPC = {
  internal_rpc: require('../internal_rpc'),
  external_rpc: require('../external_rpc')
}

// it's just handier when Buffer is stringified into hex vs Type: Buffer..
Buffer.prototype.toJSON = function() {
  return this.toString('hex')
}

Array.prototype.randomElement = function() {
  return this[Math.floor(Math.random() * this.length)]
}

openBrowser = () => {
  const url = `http://${localhost}:${base_port}/#auth_code=${PK.auth_code}`
  l(note(`Open ${link(url)} in your browser`))

  // opn doesn't work in SSH console
  if (!argv.silent && !argv.s) {
    opn(url)
  }
}

trim = (buffer, len = 4) => toHex(buffer).substr(0, len)

l = (...args) => {
  console.log(...args)
}

wscb = (...args) => {
  //console.log("Received from websocket ", args)
}

// offchain logs
loff = (text) => l(`${chalk.green(`       ⠟ ${text}`)}`)

fatal = async (reason) => {
  global.repl = null
  l(errmsg(reason))

  if (me) {
    react({reload: true}) //reloads UI window
    //me.intervals.map(clearInterval)

    await Periodical.syncChanges()
    //.then(async () => {
    //await sequelize.close()
    //await privSequelize.close()
    await sleep(500)
    process.exit()
    //})
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
    } catch (e) {
      return []
    }
  } else {
    try {
      return rlp.encode(a)
    } catch (e) {
      return new Buffer([])
    }
  }
}

// for testnet handicaps
sleep = async function(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

var {performance} = require('perf_hooks')

// critical section for a specific key
// https://en.wikipedia.org/wiki/Critical_section
section = async function(key, job) {
  return new Promise(async (resolve) => {
    key = JSON.stringify(key)

    if (section.q[key]) {
      if (section.q[key].length > 10) {
        l('Queue overflow for: ' + key)
      }

      section.q[key].push([job, resolve])
    } else {
      section.q[key] = [[job, resolve]]

      while (section.q[key].length > 0) {
        try {
          let [got_job, got_resolve] = section.q[key].shift()
          let started = performance.now()

          //let deadlock = setTimeout(function() {
          //  fatal('Deadlock in q ' + key)
          //}, 20000)

          got_resolve(await got_job())

          //clearTimeout(deadlock)
          //l('Section took: ' + (performance.now() - started))
        } catch (e) {
          l('Error in critical section: ', e)
          setTimeout(() => {
            fatal(e)
          }, 100)
        }
      }
      delete section.q[key]
    }
  })
}
section.q = {}

current_db_hash = () => {
  return Buffer.alloc(1)
}

onchain_state = async () => {
  await Periodical.syncChanges()
  //TODO: fix. may cause race condition and lock db for reading breaking other operations

  var out = child_process
    .execSync(
      `shasum -a 256 ${datadir}/onchain/k.json ${datadir}/onchain/db.sqlite `
    )
    .toString()
    .split(/[ \n]/)

  return sha3(concat(fromHex(out[0]), fromHex(out[3])))
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

hrtime = () => {
  let hrTime = process.hrtime()
  return hrTime[0] * 1000000 + Math.round(hrTime[1] / 1000)
}
perf = (label) => {
  let started_at = hrtime()

  // unlocker you run in the end
  return () => {
    if (!perf.entries[label]) perf.entries[label] = []

    perf.entries[label].push(hrtime() - started_at)
  }
}

perf.entries = {}
perf.stats = (label) => {
  if (label) {
    var sum,
      avg = 0

    if (perf.entries[label].length) {
      sum = perf.entries[label].reduce(function(a, b) {
        return a + b
      })
      avg = sum / perf.entries[label].length
    }
    return [parseInt(sum), parseInt(avg)]
  } else {
    Object.keys(perf.entries).map((key) => {
      let nums = perf.stats(key)
      l(`${key}: sum ${commy(nums[0], false)} avg ${commy(nums[1], false)}`)
    })
  }
}

beforeFee = (amount, hub) => {
  new_amount = Math.round((amount / (10000 - hub.fee_bps)) * 10000)
  if (new_amount == amount) new_amount = amount + K.min_fee
  if (new_amount > amount + K.max_fee) new_amount = amount + K.max_fee
  amount = new_amount

  return new_amount
}

afterFees = (amount, hubs) => {
  if (!(hubs instanceof Array)) hubs = [hubs]
  for (var hub of hubs) {
    let taken_fee = Math.round((amount * hub.fee_bps) / 10000)
    if (taken_fee == 0) taken_fee = K.min_fee
    if (taken_fee > K.max_fee) taken_fee = K.max_fee
    amount = amount - taken_fee
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
