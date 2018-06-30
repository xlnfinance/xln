require('./utils')
require('./browser')

var SegfaultHandler = require('segfault-handler')
SegfaultHandler.registerHandler('crash.log')

argv = require('minimist')(process.argv.slice(2), {
  string: ['username', 'pw']
})

on_server = !!argv['prod-server']
datadir = argv.datadir ? argv.datadir : 'data'
base_port = argv.p ? parseInt(argv.p) : 8001
trace = !!argv.trace
argv.syncdb = argv.syncdb != 'off'
node_started_at = ts()

process.title = 'Fair ' + base_port

if (on_server) {
  let Raven = require('raven')
  Raven.config(
    'https://299a833b1763402f9216d8e7baeb6379@sentry.io/1226040'
  ).install()
}

// This is the most important function in the whole project. Make sure you understand it!
// Defines how payment channels work, based on "insurance" and delta=(ondelta+offdelta)
// There are 3 major scenarios of delta position
// . is 0 point, | is delta, = is insured, - is uninsured
// 4,6  .====--| (left user owns entire insurance, has 2 uninsured)
// 4,2  .==|==   (left and right both have 2 insured)
// 4,-2 |--.==== (right owns entire insurance, 2 in uninsured balance)
// https://codepen.io/anon/pen/wjLGgR visual demo
resolveChannel = (insurance, delta, is_left = true) => {
  var parts = {
    // left user promises only with negative delta, scenario 3
    they_uninsured: delta < 0 ? -delta : 0,
    insured: delta > insurance ? insurance : delta > 0 ? delta : 0,
    they_insured:
      delta > insurance ? 0 : delta > 0 ? insurance - delta : insurance,
    // right user promises when delta > insurance, scenario 1
    uninsured: delta > insurance ? delta - insurance : 0
  }

  var total =
    parts.they_uninsured + parts.uninsured + parts.they_insured + parts.insured

  if (total < 100) total = 100

  var bar = (amount, symbol) => {
    if (amount == 0) return ''
    return Array(1 + Math.ceil(amount * 100 / total)).join(symbol)
  }

  // visual representations of state in ascii and text
  if (delta < 0) {
    parts.ascii_channel =
      '|' + bar(parts.they_uninsured, '-') + bar(parts.they_insured, '=')
  } else if (delta < insurance) {
    parts.ascii_channel =
      bar(parts.insured, '=') + '|' + bar(parts.they_insured, '=')
  } else {
    parts.ascii_channel =
      bar(parts.insured, '=') + bar(parts.uninsured, '-') + '|'
  }

  // default view is left. if current user is right, simply reverse
  if (!is_left) {
    ;[
      parts.they_uninsured,
      parts.insured,
      parts.they_insured,
      parts.uninsured
    ] = [
      parts.uninsured,
      parts.they_insured,
      parts.insured,
      parts.they_uninsured
    ]
  }

  return parts
}

refresh = function(ch) {
  // filter all payments by some trait
  ch.inwards = []
  ch.outwards = []

  ch.hashlock_hold = [0, 0]

  for (let i = 0; i < ch.payments.length; i++) {
    let t = ch.payments[i]

    var typestatus = t.type + t.status

    if (
      ['addack', 'delnew', ch.rollback[0] > 0 ? 'delsent' : 'addsent'].includes(
        typestatus
      )
    ) {
      ch[t.is_inward ? 'inwards' : 'outwards'].push(t)
      ch.hashlock_hold[t.is_inward ? 0 : 1] += t.amount
    }
  }

  Object.assign(
    ch,
    resolveChannel(ch.ins.insurance, ch.ins.ondelta + ch.d.offdelta, ch.left)
  )

  // Canonical state
  ch.state = [
    map('disputeWith'),
    [
      ch.left ? ch.d.myId : ch.d.partnerId,
      ch.left ? ch.d.partnerId : ch.d.myId,
      ch.d.nonce,
      ch.d.offdelta,
      ch.d.asset
    ],
    ch[ch.left ? 'inwards' : 'outwards'].map((t) => t.toLock()),
    ch[ch.left ? 'outwards' : 'inwards'].map((t) => t.toLock())
  ]

  // inputs are like bearer cheques and can be used any minute, so we deduct them
  ch.payable =
    ch.insured +
    ch.uninsured +
    ch.d.they_hard_limit -
    ch.they_uninsured -
    ch.d.input_amount -
    ch.hashlock_hold[1]

  ch.they_payable =
    ch.they_insured +
    ch.they_uninsured +
    ch.d.hard_limit -
    ch.uninsured -
    ch.d.they_input_amount -
    ch.hashlock_hold[0]

  // All stuff we show in the progress bar in the wallet
  ch.bar = ch.they_uninsured + ch.insured + ch.they_insured + ch.uninsured

  ch.ascii_states = ascii_state(ch.state)
  if (ch.d.signed_state) {
    let st = r(ch.d.signed_state)
    prettyState(st)
    st = ascii_state(st)
    if (st != ch.ascii_states) {
      ch.ascii_states += st
    }
  }

  return ch.state
}

saveId = async function(obj) {
  // only save if it has no id now
  if (!obj.id) await obj.save()
}


cache = {
  ins: {},
  users: {},
  ch: {}
}

exitsync = false

initDashboard = require('./init_dashboard')

derive = async (username, pw) => {
  return new Promise((resolve, reject) => {
    require('../lib/scrypt')(
      pw,
      username,
      {
        N: Math.pow(2, 12),
        r: 8,
        p: 1,
        dkLen: 32,
        encoding: 'binary'
      },
      (r) => {
        r = bin(r)
        resolve(r)
      }
    )

    /* Native scrypt. TESTNET: we use pure JS scrypt
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

sync = () => {
  if (K.prev_hash) {
    // if we're member then sync from anyone except us
    var set = me.my_member ? Members.filter((m) => m != me.my_member) : Members
    var chosen = set[Math.floor(Math.random() * set.length)]

    //|| me.my_member

    if (K.ts < ts() - K.blocktime / 2 || me.my_member) {
      me.send(chosen, 'sync', r([fromHex(K.prev_hash)]))
    } else {
      l('No need to sync, K.ts is recent')
    }
  } else {
    l('No K.prev_hash to sync from')
  }
}

if (!fs.existsSync('data')) {
  fs.mkdirSync('data')
  fs.mkdirSync('data/onchain')
}
require('./db/onchain_db')

use_force = false
if (!fs.existsSync('./' + datadir + '/offchain')) {
  fs.mkdirSync('./' + datadir + '/offchain')
  use_force = true
}

require('./db/offchain_db')
;(async () => {
  await privSequelize.sync({force: use_force})

  if (argv.genesis) {
    require('../tools/genesis')()
  } else if (argv.cluster) {
    var cluster = require('cluster')
    if (cluster.isMaster) {
      cluster.fork()

      cluster.on('exit', function(worker, code, signal) {
        console.log('exit')
        cluster.fork()
      })
    }

    if (cluster.isWorker) {
      initDashboard()
    }
  } else {
    initDashboard()
  }
})()
/* Get randos:
var addr = []
for (let i = 8001; i < 8200; i++){
  let username = i.toString()
  let seed = await derive(username, 'password')
  await me.init(username, seed)
  addr.push(me.address)
}
*/
if (argv.monkey) {
  randos = fs
    .readFileSync('./tools/randos.txt')
    .toString()
    .split('\n')
    .slice(3, parseInt(argv.monkey) - 8000)
  l('Loaded randos: ' + randos.length)
}

openBrowser = () => {
  var url = `http://${localhost}:${base_port}/#?auth_code=${PK.auth_code}`
  l(note(`Open ${link(url)} in your browser`))
  try{ opn(url) } catch(e){}
}
