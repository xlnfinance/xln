#!/usr/bin/env node

require('./src/utils')

require('./src/db/onchain_db')
require('./src/db/offchain_db')

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

    cached_result.proposals = await Proposal.findAll({
      order: [['id', 'DESC']],
      include: {all: true}
    })

    cached_result.users = await User.findAll({include: {all: true}})
    cached_result.insurances = await Insurance.findAll({include: {all: true}})

    cached_result.blocks = (await Block.findAll({
      limit: 500,
      order: [['id', 'desc']],
      where: {
        meta: {[Sequelize.Op.not]: null}
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

    cached_result.payments = await Payment.findAll({
      order: [['id', 'desc']],
      include: {all: true}
    })

    if (me.my_hub) {
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
    }
  }

  // TODO: read hash just after snapshot generation
  if (me.my_member && K.last_snapshot_height) {
    var filename = `Failsafe-${K.last_snapshot_height}.tar.gz`
    var cmd = 'shasum -a 256 private/' + filename

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
  await cache()

  if (me.id) {
    result.record = await me.byKey()

    result.username = me.username

    result.address = toHex(r([bin(me.box.publicKey), me.pubkey]))
    result.pubkey = toHex(me.pubkey)

    //result.invoices = invoices
    result.pending_tx = PK.pending_tx

    result.channels = await me.channels()
  }

  if (me.browser) {
    me.browser.send(
      JSON.stringify({
        result: Object.assign(result, cached_result),
        id: id
      })
    )
  }
}

// TODO: Move from memory to persistent DB
cached_result = {
  history: [],
  my_log: ''
}

invoices = {}

initDashboard = async (a) => {
  // auto reloader for debugging
  setInterval(() => {
    fs.stat('../restart', (e, f) => {
      if (!f) return l('Touch ../restart file')
      var restartedAt = restartedAt ? restartedAt : f.atimeMs

      if (f && f.atimeMs != restartedAt) {
        process.exit(0)
      }
    })
  }, 1000)

  if (fs.existsSync('data/k.json')) {
    l('Loading K data')
    var json = fs.readFileSync('data/k.json')
    K = JSON.parse(json)

    Members = JSON.parse(json).members // another object ref
    for (m of Members) {
      m.pubkey = Buffer.from(m.pubkey, 'hex')
      m.block_pubkey = Buffer.from(m.block_pubkey, 'hex')
    }
  } else {
    throw 'No K.json'
  }

  await privSequelize.sync({force: false})

  var finalhandler = require('finalhandler')
  var serveStatic = require('serve-static')

  var cb = function(req, res) {
    if (req.url.match(/^\/Failsafe-([0-9]+)\.tar\.gz$/)) {
      var file = 'private' + req.url
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
        me.queue.push(async () => {
          return RPC.internal_rpc(res, queryData)
        })
      })
    } else {
      serveStatic('./wallet')(req, res, finalhandler(req, res))
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

  if (fs.existsSync('private/pk.json')) {
    PK = JSON.parse(fs.readFileSync('private/pk.json'))
  } else {
    // used to authenticate browser sessions to this daemon
    PK = {
      auth_code: toHex(crypto.randomBytes(32)),

      pending_tx: []
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

  me.processQueue()
  var url = `http://${localhost}:${base_port}/#auth_code=${PK.auth_code}`
  l('Open ' + url + ' in your browser')
  server.listen(base_port).once('error', function(err) {
    if (err.code === 'EADDRINUSE') {
      l('port is currently in use')
      process.exit()
    }
  })

  // opn doesn't work in SSH console
  if (base_port != 443 && !argv.silent) opn(url)

  localwss = new ws.Server({server: server, maxPayload: 64 * 1024 * 1024})

  localwss.on('error', function(err) {
    console.error(err)
  })
  localwss.on('connection', function(ws) {
    ws.on('message', (msg) => {
      me.queue.push(async () => {
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

base_port = argv.p ? parseInt(argv.p) : 8000
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

process.on('unhandledRejection', (r) => console.log(r))

repl = require('repl').start('> ')
_eval = repl.eval

// top level await in repl
repl.eval = (cmd, context, filename, callback) => {
  if (cmd.indexOf('await') != -1)
    cmd = `(function(){ async function _wrap() { console.log(${cmd}) } return _wrap() })()`
  _eval(cmd, context, filename, callback)
}
