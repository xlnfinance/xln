require('./utils/system')
require('./utils/channel')
require('./utils/debug')

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

require('./db/onchain_db')
require('./db/offchain_db')

cache = {
  ins: {},
  users: {},
  ch: {}
}

exitsync = false

monkeys = []

sync = () => {
  if (!K.prev_hash) {
    return l('No K.prev_hash to sync from')
  }

  const sendSync = () => {
    // if we're member then sync from anyone except us
    const validatorSet = me.my_validator
      ? Validators.filter((m) => m != me.my_validator)
      : Validators
    const randomChosenValidator = validatorSet.randomElement()
    const prevHash = r([fromHex(K.prev_hash)])
    me.send(randomChosenValidator, 'sync', prevHash)
  }

  if (me.my_member) {
    return sendSync()
  }

  if (K.ts < ts() - K.blocktime / 2) {
    return sendSync()
  }

  return l('No need to sync, K.ts is recent')
}

loadKFile = (datadir) => {
  l('Loading K data')
  const kFile = './' + datadir + '/onchain/k.json'
  if (!fs.existsSync(kFile)) {
    fatal(`Unable to read ${highlight(kFile)}, quitting`)
  }

  const json = fs.readFileSync(kFile)
  return JSON.parse(json)
}

loadPKFile = (datadir) => {
  l('Loading PK data')
  const pkFile = './' + datadir + '/offchain/pk.json'
  if (!fs.existsSync(pkFile)) {
    // used to authenticate browser sessions to this daemon
    return {
      auth_code: toHex(crypto.randomBytes(32)),
      pending_batch: null
    }
  }

  const json = fs.readFileSync(pkFile)
  return JSON.parse(json)
}

loadValidators = (validators) => {
  return validators.map((m) => {
    m.pubkey = Buffer.from(m.pubkey, 'hex')
    m.block_pubkey = Buffer.from(m.block_pubkey, 'hex')
    return m
  })
}

generateMonkeys = async () => {
  const derive = require('./utils/derive')
  const addr = []
  for (let i = 8001; i < 8200; i++) {
    const username = i.toString()
    const seed = await derive(username, 'password')
    const me = new Me()
    await me.init(username, seed)
    addr.push(me.address)
  }
  // save new-line separated monkey addresses
  await promise_writeFile('./tools/monkeys.txt', addr.join('\n'))
}

loadMonkeys = (monkey_port) => {
  const monkeys = fs
    .readFileSync('./tools/monkeys.txt')
    .toString()
    .split('\n')
    .slice(3, parseInt(monkey_port) - 8000)

  l('Loaded monkeys: ' + monkeys.length)

  return monkeys
}

use_force = false
if (!fs.existsSync('./' + datadir)) {
  fs.mkdirSync('./' + datadir)
  fs.mkdirSync('./' + datadir + '/onchain')
}

if (!fs.existsSync('./' + datadir + '/offchain')) {
  fs.mkdirSync('./' + datadir + '/offchain')
  use_force = true
}

startFairlayer = async () => {
  if (argv.generate_monkeys) {
    await generateMonkeys()
  }

  if (argv.monkey) {
    monkeys = loadMonkeys(argv.monkey)
  }

  await privSequelize.sync({force: use_force})

  if (argv.genesis) {
    startGenesis = require('./utils/genesis')
    await startGenesis()
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
