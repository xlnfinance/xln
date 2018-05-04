#!/usr/bin/env node
require('./src/utils')

// Defines promised/insured for both users based on insurance and delta=(ondelta+offdelta)
// There are 3 major scenarios of delta position
// . is 0, | is delta, = is insurance, - is promised
// 4,6  .====--|
// 4,2  .==|==
// 4,-2 |--.====
resolveChannel = (insurance, delta, is_left = true) => {
  var parts = {
    // left user promises only with negative delta, scenario 3
    promised: delta < 0 ? -delta : 0,
    insured: delta > insurance ? insurance : delta > 0 ? delta : 0,
    they_insured:
      delta > insurance ? 0 : delta > 0 ? insurance - delta : insurance,
    // right user promises when delta goes beyond insurance, scenario 1
    they_promised: delta > insurance ? delta - insurance : 0
  }

  // default view is left. if current user is right, simply reverse
  if (!is_left) {
    ;[
      parts.promised,
      parts.insured,
      parts.they_insured,
      parts.they_promised
    ] = [parts.they_promised, parts.they_insured, parts.insured, parts.promised]
  }

  return parts
}

Buffer.prototype.toJSON = function() {
  return this.toString('hex')
}

// Called once in a while to cache current state of everything and flush it to browser
// TODO: better way to keep app reactive?
cache = async (i) => {
  if (K) {
    cached_result.my_hub = me.my_hub

    cached_result.my_member = !!me.my_member

    cached_result.K = K

    cached_result.current_db_hash = current_db_hash().toString('hex')

    await Promise.all([
      async () => {
        cached_result.proposals = await Proposal.findAll({
          order: [['id', 'DESC']],
          include: {all: true}
        })
      },
      async () => {
        cached_result.users = await User.findAll({include: {all: true}})
      },
      async () => {
        cached_result.insurances = await Insurance.findAll({
          include: {all: true}
        })
      },
      async () => {
        cached_result.hashlocks = await Hashlock.findAll({include: {all: true}})
      },
      async () => {
        cached_result.assets = await Asset.findAll({include: {all: true}})
      },
      async () => {
        cached_result.blocks = (await Block.findAll({
          limit: 500,
          order: [['id', 'desc']],
          where: {
            meta: {[Op.not]: null}
          }
        })).map((b) => {
          var [methodId, built_by, prev_hash, timestamp, tx_root, db_hash] = r(
            b.header
          )

          return {
            id: b.id,
            prev_hash: toHex(b.prev_hash),
            hash: toHex(b.hash),
            built_by: readInt(built_by),
            timestamp: readInt(timestamp),
            meta: JSON.parse(b.meta),
            total_tx: b.total_tx
          }
        })
      }
    ])
  }

  // TODO: read hash just after snapshot generation
  if (me.my_member && K.last_snapshot_height) {
    var filename = `Failsafe-${K.last_snapshot_height}.tar.gz`
    var cmd = `shasum -a 256 ${datadir}/offchain/${filename}`

    require('child_process').exec(cmd, async (er, out, err) => {
      if (out.length == 0) {
        l('This state doesnt exist')
        return false
      }

      var out_hash = out.split(' ')[0]

      var our_location =
        me.my_member.location.indexOf(localhost) != -1
          ? `http://${localhost}:8000/`
          : `https://failsafe.network/`

      cached_result.install_snippet = `id=fs
f=${filename}
mkdir $id && cd $id && curl ${our_location}$f -o $f
if [[ -x /usr/bin/sha256sum ]] && sha256sum $f || shasum -a 256 $f | grep \\
  ${out_hash}; then
  tar -xzf $f && rm $f && ./install
  node fs -p8001
fi
`
    })
  }
}

// Flush an object to browser websocket
react = async (result = {}, id = 1) => {
  // no alive browser socket
  if (!me.browser || me.browser.readyState != 1) {
    return l('No working me.browser')
  }

  cache()

  if (me.id) {
    if (me.my_hub) {
      /*
      var deltas = await Delta.findAll({where: {myId: me.record.id}})
      var promised = 0
      for (var d of deltas) {
        var ch = await me.getChannel(d.userId)
        if (ch.delta > 0) promised += ch.promised
      }

      if (
        cached_result.history[0] &&
        cached_result.history[0].delta != promised
      ) {
        cached_result.history.unshift({
          date: new Date(),
          delta: promised
        })
      }
      */
    }

    result.payments = await Payment.findAll({
      order: [['id', 'desc']],
      include: {all: true}
    })

    result.record = await me.byKey()

    result.username = me.username
    /*
          var offered_partners = (await me.channels())
            .sort((a, b) => b.they_payable - a.they_payable)
            .filter((a) => a.they_payable >= amount)
            .map((a) => a.partner)
            .join('_')
            */
    result.address = me.address
    result.pubkey = toHex(me.pubkey)

    result.pending_batch = PK.pending_batch

    result.channels = await me.channels()
  }

  try {
    me.browser.send(
      JSON.stringify({
        result: Object.assign(result, cached_result),
        id: id
      })
    )
  } catch (e) {
    l('Failed browser send')
  }
}

// TODO: Move from memory to persistent DB
cached_result = {
  history: [],
  my_log: ''
}

initDashboard = async (a) => {
  // auto reloader for debugging
  l(note(`Touch ${highlight('../restart')} to restart`))
  setInterval(() => {
    fs.stat('../restart', (e, f) => {
      if (!f) return
      var restartedAt = restartedAt ? restartedAt : f.atimeMs

      if (f && f.atimeMs != restartedAt) {
        gracefulExit('restarting')
      }
    })
  }, 1000)

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

  await privSequelize.sync({force: false})

  var finalhandler = require('finalhandler')
  var serveStatic = require('serve-static')
  var Parcel = require('parcel-bundler')

  var bundler = new Parcel('wallet/index.html', {
    logLevel: 2
    // for more options https://parceljs.org/api.html
  }).middleware()

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
        me.addQueue(async () => {
          return RPC.internal_rpc(res, queryData)
        })
      })
    } else if (req.url == '/sdk.html') {
      serveStatic('./wallet')(req, res, finalhandler(req, res))
    } else {
      bundler(req, res, finalhandler(req, res))
    }
  }

  // this serves dashboard HTML page
  var on_server = fs.existsSync(
    '/etc/letsencrypt/live/failsafe.network/fullchain.pem'
  )

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

  repl.context.me = me

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

  //me.processQueue()
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
      // internal requests go in the beginning of the queue
      me.addQueue(async () => {
        return RPC.internal_rpc(ws, msg)
      })
    })
  })
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

lock = require('util').promisify(
  require('./lib/lock')(require('redis').createClient({prefix: base_port}))
)

if (!fs.existsSync('data')) {
  fs.mkdirSync('data')
  fs.mkdirSync('data/onchain')
  fs.mkdirSync('data/offchain')
}
require('./src/db/onchain_db')
require('./src/db/offchain_db')
;(async () => {
  if (argv.console) {
    initDashboard()
  } else if (argv.genesis) {
    require('./src/genesis')(argv.genesis)
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

var randos = `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`
  .split('\n')
  .slice(0, 5)

if (argv.monkey) {
  setTimeout(() => {
    me.send(Members[0], 'testnet', concat(bin([1]), bin(me.address)))

    randos.splice(randos.indexOf(me.address), 1) // remove our addr

    monk = setInterval(() => {
      /*
      if (Math.random() > 0.7) {
        me.send(Members[0], 'testnet', concat(bin([1]), bin(me.address)))
      }
      */

      me.addQueue(async () => {
        return me.payChannel({
          destination: randos[Math.floor(Math.random() * randos.length)],
          amount: 100 + Math.round(Math.random() * 10) //$1-2
        })
      })
    }, 7000)

    setTimeout(() => {
      clearInterval(monk)
    }, 300000)
  }, 20000)
}

process.on('unhandledRejection', (err) => {
  if (err.name == 'SequelizeTimeoutError') return l(err)

  fatal(`Fatal rejection, quitting\n\n${err ? err.stack : err}`)
})

process.on('uncaughtException', (err) => {
  if (err.name == 'SequelizeTimeoutError') return l(err)
  fatal(`Fatal exception, quitting\n\n${err ? err.stack : err}`)
})

l(`\n${note('Welcome to FS REPL!')}`)
repl = require('repl').start(note(''))
_eval = repl.eval
