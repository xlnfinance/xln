// Convenience-first, later globals to be slowly reduced.

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

nacl = require('../../lib/nacl')

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
stringify = require('../../lib/stringify')
rlp = require('../../lib/rlp') // patched rlp for signed-integer

Sequelize = require('sequelize')
Op = Sequelize.Op

Me = require('../me').Me

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

// returns validator making block right now, use skip=true to get validator for next slot
nextValidator = (skip = false) => {
  const currentIndex = Math.floor(ts() / K.blocktime) % K.total_shares

  let searchIndex = 0
  for (let i = 0; i < Validators.length; i++) {
    const current = Validators[i]
    searchIndex += current.shares

    if (searchIndex <= currentIndex) continue
    if (skip == false) return current

    // go back to 0
    if (currentIndex + 1 == K.total_shares) return Validators[0]

    // same validator
    if (currentIndex + 1 < searchIndex) return current

    // next validator
    return Validators[i + 1]
  }
}

// cache layer stores most commonly edited records:
// channels, payments, users and insurances
// also K.json is stored
syncdb = async (opts = {}) => {
  return section('syncdb', async () => {
    var all = []

    if (K) {
      let K_dump = stringify(K)

      // rewrite only if changed
      if (K_dump != cache.last_K_dump) {
        fs.writeFileSync(
          require('path').resolve(
            __dirname,
            '../../' + datadir + '/onchain/k.json'
          ),
          K_dump,
          function(err) {
            if (err) return console.log(err)
          }
        )
        cache.last_K_dump = K_dump
      }
    }

    // saving all deltas and corresponding payment objects to db
    // it only saves changed() records, so call save() on everything

    for (var key in cache.users) {
      var u = cache.users[key]

      if (u.id && u.changed()) {
        all.push(u.save())
      }
    }

    if (opts.flush == 'users') cache.users = {}

    for (var key in cache.ins) {
      var u = cache.ins[key]

      if (u.id && u.changed()) {
        all.push(u.save())
      }
    }

    var new_ch = {}

    for (let key in cache.ch) {
      let ch = cache.ch[key]

      await section(['use', ch.d.partnerId, ch.d.asset], async () => {
        ch.payments = ch.payments.filter((t) => {
          if (t.changed()) {
            all.push(t.save())
          }

          return t.type + t.status != 'delack'
        })

        let evict = ch.last_used < ts() - K.cache_timeout

        //if (ch.d.changed()) {
        let promise = ch.d.save()

        // the channel is only evicted after it is properly saved in db
        if (evict) {
          //delete cache.ch[key]

          promise = promise.then(() => {
            //l('Evict: ' + trim(ch.d.partnerId), ch.d.ack_requested_at)
          })
        } else {
          //new_ch[key] = ch
        }

        all.push(promise)
      })
    }

    //cache.ch = new_ch

    if (all.length > 0) l(`syncdb done: ${all.length}`)
    return await Promise.all(all)
  })
}

parseAddress = (addr) => {
  addr = addr.toString()
  let invoice = false

  if (addr.includes('#')) {
    // the invoice is encoded as #hash in destination and takes precedence over manually sent invoice
    ;[addr, invoice] = addr.split('#')
  }
  let parts = []
  let hubs = [1]

  try {
    parts = r(base58.decode(addr))
    if (parts[2]) hubs = parts[2].map(readInt)
  } catch (e) {}

  // both pubkeys and hub list must be present
  if (
    parts[0] &&
    parts[0].length == 32 &&
    parts[1] &&
    parts[1].length == 32 &&
    hubs.length > 0
  ) {
    return {
      box_pubkey: parts[0],
      pubkey: parts[1],
      hubs: hubs,
      invoice: invoice,
      address: addr
    }
  } else {
    l('bad address ', addr)
    return false
  }
}

trim = (ad) => toHex(ad).substr(0, 4)

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
    me.intervals.map(clearInterval)

    await syncdb()
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
    var fee = Math.round((amount / (1 + fee)) * fee)
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
