#!/usr/bin/env node
require('./src/utils')
require('./src/browser')

// This is the most important function in the whole project. Make sure you understand it!
// Defines how payment channels work, based on "insurance" and delta=("ondelta"+"offdelta")
// There are 3 major scenarios of delta position
// . is 0 point, | is delta, = is insured, - is uninsured
// 4,6  .====--| (left user owns entire insurance, has 2 uninsured)
// 4,2  .==|==   (left and right both have 2 insured)
// 4,-2 |--.==== (right owns entire insurance, 2 in uninsured balance)
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
  Object.assign(
    ch,
    resolveChannel(ch.insurance, ch.ondelta + ch.d.offdelta, ch.left)
  )

  // Canonical state
  ch.state = [
    methodMap('disputeWith'),
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
    ch.d.input_amount
  //ch.outwards.reduce((a, b) => a + b.amount)

  ch.they_payable =
    ch.they_insured +
    ch.they_uninsured +
    ch.d.hard_limit -
    ch.uninsured -
    ch.d.they_input_amount
  //ch.inwards.reduce((a, b) => a.amount + b.amount)

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

on_server = fs.existsSync(
  '/etc/letsencrypt/live/failsafe.network/fullchain.pem'
)
initDashboard = async (a) => {
  // auto reloader for debugging
  /*
  l(note(`Touch ${highlight('../restart')} to restart`))
  setInterval(() => {
    fs.stat('../restart', (e, f) => {
      if (!f) return
      var restartedAt = restartedAt ? restartedAt : f.atimeMs

      if (f && f.atimeMs != restartedAt) {
        gracefulExit('restarting')
      }
    })
  }, 1000)*/

  var kFile = datadir + '/onchain/k.json'
  if (fs.existsSync(kFile)) {
    l('Loading K data')
    var json = fs.readFileSync(kFile)
    K = JSON.parse(json)

    Members = JSON.parse(json).members // another object ref
    for (m of Members) {
      m.pubkey = Buffer.from(m.pubkey, 'hex')
      m.block_pubkey = Buffer.from(m.block_pubkey, 'hex')
    }
  } else {
    fatal(`Unable to read ${highlight(kFile)}, quitting`)
  }

  var finalhandler = require('finalhandler')
  var serveStatic = require('serve-static')

  var bundler
  if (argv['wallet-url']) {
    let walletUrl = argv['wallet-url']
    let http = require('http')
    let proxy = require('http-proxy').createProxyServer({
      target: walletUrl
    })
    bundler = (req, res) => proxy.web(req, res, {}, finalhandler(req, res))
    let retries = 0

    while (true) {
      const statusCode = await new Promise((resolve) => {
        l('Reaching wallet ', walletUrl)
        http
          .get(walletUrl, (res) => {
            const {statusCode} = res
            resolve(statusCode)
          })
          .on('error', (e) => {
            resolve(404)
          })
      })
      if (statusCode !== 200) {
        if (retries > 0) {
          l(note(`Waiting for Parcel (HTTP ${statusCode})`))
        }
        if (retries > 5) {
          throw new Error('No parcel on ' + walletUrl)
        }
        await sleep(1000 * Math.pow(1.5, retries))
        retries++
        continue
      }
      l(note('Parcel: OK'))
      break
    }
  } else if (argv['wallet-dist']) {
    bundler = serveStatic('./dist')
  } else {
    let Parcel = require('parcel-bundler')
    bundler = new Parcel('wallet/index.html', {
      logLevel: 2
      // for more options https://parceljs.org/api.html
    }).middleware()
  }

  var cb = function(req, res) {
    if (req.url.match(/^\/Failsafe-([0-9]+)\.tar\.gz$/)) {
      var file = datadir + '/offchain' + req.url
      var stat = fs.statSync(file)
      res.writeHeader(200, {'Content-Length': stat.size})
      var fReadStream = fs.createReadStream(file)
      fReadStream.on('data', function(chunk) {
        if (!res.write(chunk)) {
          fReadStream.pause()
        }
      })
      fReadStream.on('end', function() {
        res.end()
      })
      res.on('drain', function() {
        fReadStream.resume()
      })
    } else if (req.url == '/rpc') {
      var queryData = ''
      req.on('data', function(data) {
        queryData += data
      })

      req.on('end', function() {
        RPC.internal_rpc(res, queryData)
      })
    } else if (req.url == '/sdk.html') {
      serveStatic('./wallet')(req, res, finalhandler(req, res))
    } else {
      bundler(req, res, finalhandler(req, res))
    }
  }

  // this serves dashboard HTML page
  if (on_server) {
    cert = {
      cert: fs.readFileSync(
        '/etc/letsencrypt/live/failsafe.network/fullchain.pem'
      ),
      key: fs.readFileSync('/etc/letsencrypt/live/failsafe.network/privkey.pem')
    }
    var server = require('https').createServer(cert, cb)

    // redirecting from http://
    if (base_port == 443) {
      require('http')
        .createServer(function(req, res) {
          res.writeHead(301, {Location: 'https://' + req.headers['host']})
          res.end()
        })
        .listen(80)
    }
  } else {
    cert = false
    var server = require('http').createServer(cb)
  }

  me = new Me()

  if (fs.existsSync(datadir + '/offchain/pk.json')) {
    PK = JSON.parse(fs.readFileSync(datadir + '/offchain/pk.json'))
  } else {
    // used to authenticate browser sessions to this daemon
    PK = {
      auth_code: toHex(crypto.randomBytes(32)),

      pending_batch: null
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

  var url = `http://${localhost}:${base_port}/#?auth_code=${PK.auth_code}`
  l(note(`Open ${link(url)} in your browser`))
  server.listen(base_port).once('error', function(err) {
    if (err.code === 'EADDRINUSE') {
      fatal(`Port ${highlight(base_port)} is currently in use, quitting`)
    }
  })

  // opn doesn't work in SSH console
  if (base_port != 443 && !argv.silent) opn(url)

  internal_wss = new ws.Server({server: server, maxPayload: 64 * 1024 * 1024})

  internal_wss.on('error', function(err) {
    console.error(err)
  })
  internal_wss.on('connection', function(ws) {
    ws.on('message', (msg) => {
      RPC.internal_rpc(ws, msg)
    })
  })

  l(`\n${note('Welcome to FS REPL!')}`)
  repl = require('repl').start(note(''))
  repl.context.me = me
}

derive = async (username, pw) => {
  return new Promise((resolve, reject) => {
    require('./lib/scrypt')(
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
    me.send(
      Members[Math.floor(Math.random() * Members.length)],
      'sync',
      Buffer.from(K.prev_hash, 'hex')
    )
  }
}

argv = require('minimist')(process.argv.slice(2), {
  string: ['username', 'pw']
})

datadir = argv.datadir ? argv.datadir : 'data'
base_port = argv.p ? parseInt(argv.p) : 8000

if (!fs.existsSync('data')) {
  fs.mkdirSync('data')
  fs.mkdirSync('data/onchain')
}
require('./src/db/onchain_db')

use_force = false
if (!fs.existsSync(datadir + '/offchain')) {
  fs.mkdirSync(datadir + '/offchain')
  use_force = true
}

require('./src/db/offchain_db')
;(async () => {
  await privSequelize.sync({force: use_force})

  if (argv.console) {
    initDashboard()
  } else if (argv.genesis) {
    require('./tools/genesis')()
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

let ooops = (err) => {
  if (err.name == 'SequelizeTimeoutError') return
  l(err)
  fatal(`Fatal rejection, quitting`)
}
process.on('unhandledRejection', ooops)
process.on('uncaughtException', ooops)
