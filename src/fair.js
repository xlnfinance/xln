require('./utils/system')
require('./utils/channel')
require('./utils/debug')

const functions = require('./utils/functions')
Object.assign(global, functions)

// enumerator of all methods and tx types in the system
methodMap = require('./utils/method_map')
derive = require('./utils/derive')

require('./browser')

const SegfaultHandler = require('segfault-handler')
SegfaultHandler.registerHandler('crash.log')

argv = require('minimist')(process.argv.slice(2), {
  string: ['username', 'pw']
})

on_server = !!argv['prod-server']

if (on_server) {
  let Raven = require('raven')
  Raven.config(
    'https://299a833b1763402f9216d8e7baeb6379@sentry.io/1226040'
  ).install()
}

datadir = argv.datadir ? argv.datadir : 'data'
base_port = argv.p ? parseInt(argv.p) : 8001
trace = !!argv.trace
argv.syncdb = argv.syncdb != 'off'
node_started_at = ts()

process.title = 'Fair ' + base_port

cache = {
  ins: {},
  users: {},
  ch: {}
}

exitsync = false

monkeys = []

const OnchainDB = require('./db/onchain_db')
const OffchainDB = require('./db/offchain_db')

startFairlayer = async () => {
  const onchainDB = new OnchainDB(datadir, argv['genesis'])
  const offchainDB = new OffchainDB(
    datadir,
    argv['db'],
    argv['db-pool'],
    argv['genesis']
  )

  setupDirectories(datadir)

  try {
    await onchainDB.init()
    await offchainDB.init()
  } catch (e) {
    throw e
  }

  // temporary measure
  global.onchainDB = onchainDB
  global.offchainDB = offchainDB
  Object.assign(global, global.onchainDB.models)
  Object.assign(global, global.offchainDB.models)

  if (argv.generate_monkeys) {
    await generateMonkeys()
  }

  if (argv.monkey) {
    monkeys = loadMonkeys(argv.monkey)
  }

  if (argv.genesis) {
    startGenesis = require('./utils/genesis')
    await startGenesis(datadir)
    return
  }

  K = loadKFile(datadir)
  Validators = loadValidators(K.validators)
  PK = loadPKFile(datadir)

  // if (argv.cluster) {
  //   const cluster = require('cluster')
  //   if (cluster.isMaster) {
  //     cluster.fork()

  //     cluster.on('exit', function(worker, code, signal) {
  //       console.log('exit')
  //       cluster.fork()
  //     })
  //   }

  //   if (cluster.isWorker) {
  //     initDashboard()
  //   }

  //   return
  // }

  me = new Me()

  let username, password
  if (argv.username && argv.pw) {
    username = argv.username
    password = await derive(argv.username, argv.pw)
  } else if (PK.username && PK.seed) {
    username = PK.username
    password = Buffer.from(PK.seed, 'hex')
  }

  if (username && password) {
    await me.init(username, password)
    await me.start()
  }

  require('./init_dashboard')()

  if (argv.rpc) {
    RPC.internal_rpc('admin', argv)
  }

  // start syncing as soon as the node is started
  sync()

  l(`\n${note('Welcome to Fair REPL!')}`)
  repl = require('repl').start(note(''))
  repl.context.me = me
}

startFairlayer()
