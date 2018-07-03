// serves default wallet and internal rpc on the same port
const derive = require('./derive')

module.exports = async (a) => {
  let ooops = async (err) => {
    l('oops', err)
    if (exitsync) return false
    exitsync = true

    if (err.name == 'SequelizeTimeoutError') return
    //flush changes to db
    //await me.syncdb()
    fatal('Bye')
    //fatal(`Fatal rejection, quitting`)
  }

  process.on('unhandledRejection', ooops)
  process.on('uncaughtException', ooops)
  process.on('exit', ooops)
  process.on('beforeExit', () => {
    l('before exit')
  })

  var kFile = './' + datadir + '/onchain/k.json'
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

  let finalhandler = require('finalhandler')
  let serveStatic = require('serve-static')
  let path = require('path')

  let bundler
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
    bundler = serveStatic(path.resolve(__dirname, '../dist'))
  } else {
    let Parcel = require('parcel-bundler')
    bundler = new Parcel(path.resolve(__dirname, '../wallet/index.html'), {
      logLevel: 2
      // for more options https://parceljs.org/api.html
    }).middleware()
  }

  var cb = function(req, res) {
    // Clickjacking protection
    res.setHeader("X-Frame-Options", "DENY")

    var [path, query] = req.url.split('?')
    if (path.match(/^\/Fair-([0-9]+)\.tar\.gz$/)) {
      var file = './' + datadir + '/offchain' + req.url
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
    } else if (path=='/health') {
      res.end(JSON.stringify({
        uptime: ts() - node_started_at
      }))
    } else if (path=='/rpc') {
      res.setHeader("Content-Type", "application/json")

      var queryData = ''
      req.on('data', function(data) {
        queryData += data
      })
  
      req.on('end', function() {
        // HTTP /rpc endpoint supports passing request in GET too
        var json = Object.assign(querystring.parse(query), parse(queryData))

        if (!json.params) json.params = {}
        RPC.internal_rpc(res, json)
      })
    } else if (path == '/sdk.html') {
      serveStatic('../wallet')(req, res, finalhandler(req, res))
    } else {
      bundler(req, res, finalhandler(req, res))
    }
  }

  // this serves dashboard HTML page

  var server = require('http').createServer(cb)

  me = new Me()

  if (fs.existsSync('./' + datadir + '/offchain/pk.json')) {
    PK = JSON.parse(fs.readFileSync('./' + datadir + '/offchain/pk.json'))
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

  server.listen(on_server ? base_port+200 : base_port).once('error', function(err) {
    if (err.code === 'EADDRINUSE') {
      openBrowser()
      fatal(`Port ${highlight(base_port)} is currently in use, quitting`)
    }
  })

  // opn doesn't work in SSH console
  if (!argv.silent) openBrowser()
  internal_wss = new ws.Server({server: server, maxPayload: 64 * 1024 * 1024})

  internal_wss.on('error', function(err) {
    console.error(err)
  })
  internal_wss.on('connection', function(ws) {
    ws.on('message', (msg) => {
      RPC.internal_rpc(ws, parse(bin(msg).toString()))
    })
  })

  // start syncing as soon as the node is started
  sync()
  update_cache(true)

  if (argv.rpc) {
    RPC.internal_rpc('admin', argv)
  }

  l(`\n${note('Welcome to Fair REPL!')}`)
  repl = require('repl').start(note(''))
  repl.context.me = me
}