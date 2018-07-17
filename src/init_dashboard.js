// serves default wallet and internal rpc on the same port
module.exports = async (a) => {
  const ooops = async (err) => {
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

  const finalhandler = require('finalhandler')
  const serveStatic = require('serve-static')
  const path = require('path')

  let bundler

  var cb = function(req, res) {
    // Clickjacking protection
    res.setHeader('X-Frame-Options', 'DENY')

    var [path, query] = req.url.split('?')
    if (path.match(/^\/Fair-([0-9]+)\.tar\.gz$/)) {
      // the snapshot may have been deleted meanwhile
      try {
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
      } catch (e) {
        l(e)
      }
    } else if (path == '/health') {
      res.end(
        JSON.stringify({
          uptime: ts() - node_started_at
        })
      )
    } else if (path == '/rpc') {
      res.setHeader('Content-Type', 'application/json')

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

  if (argv['wallet-url']) {
    const walletUrl = argv['wallet-url']
    const http = require('http')
    const proxy = require('http-proxy').createProxyServer({
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

  // this serves dashboard HTML page
  var server = require('http').createServer(cb)

  openBrowser = () => {
    const url = `http://${localhost}:${base_port}/#?auth_code=${PK.auth_code}`
    l(note(`Open ${link(url)} in your browser`))
    try {
      opn(url)
    } catch (e) {}
  }

  server
    .listen(on_server ? base_port + 200 : base_port)
    .once('error', function(err) {
      if (err.code === 'EADDRINUSE') {
        openBrowser()
        fatal(
          `Port ${highlight(
            base_port
          )} is currently in use. Pass -p PORT to use another port.`
        )
      }
    })

  // opn doesn't work in SSH console
  if (!argv.silent && !argv.s) openBrowser()
  internal_wss = new ws.Server({server: server, maxPayload: 64 * 1024 * 1024})

  internal_wss.on('error', function(err) {
    console.error(err)
  })
  internal_wss.on('connection', function(ws) {
    ws.on('message', (msg) => {
      RPC.internal_rpc(ws, parse(bin(msg).toString()))
    })
  })

  update_cache(true)
}
