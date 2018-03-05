
// http://ipinfo.io/ip
module.exports = async (genesis) => {
  l('Start genesis')

  await (sequelize.sync({force: true}))

  // entity / country / infra

  K = {
    // global network pepper to protect derivation from rainbow tables
    network_name: 'main',

    usable_blocks: 0,
    total_blocks: 0,
    total_tx: 0,
    total_bytes: 0,

    total_tx_bytes: 0,

    voting_period: 10,

    bytes_since_last_snapshot: 999999999, // force to do a snapshot on first block
    last_snapshot_height: 0,
    snapshot_after_bytes: 10000,
    proposals_created: 0,

    tax: 2,

    account_creation_fee: 100,
    standalone_balance: 500, // keep $5 on your own balance for onchain tx fees

    blocksize: 200000,
    blocktime: 20,

    // each genesis is randomized
    prev_hash: toHex(crypto.randomBytes(32)), // toHex(Buffer.alloc(32)),

    risk: 10000, // recommended rebalance limit
    hard_limit: 500000, // how much can a user lose if hub is insolvent?

    dispute_delay: 5, // in how many blocks disputes are considered final

    hub_fee_base: 1, // a fee per payment
    hub_fee: 0.001, // 10 basis points

    collected_tax: 0,

    ts: 0,

    created_at: ts(),

    assets: [
      {
        ticker: 'FSD',
        name: 'Failsafe Dollar',
        total_supply: 1000
      },
      {
        ticker: 'FSB',
        name: 'Failsafe Bond (2030)',
        total_supply: 0
      },
      {
        ticker: 'ACME',
        name: 'ACME Company Stock',
        total_supply: 0
      },
      {
        ticker: 'RURABC',
        name: 'Ruble (ABC Bank)',
        total_supply: 0
      }

    ],

    min_amount: 100,
    max_amount: 300000,

    members: [],
    hubs: [],

    total_shares: 30,
    majority: 20

  }

  // members provide services: 1) build blocks 2) hubs 3) watchers 4) storage of vaults

  createMember = async (username, pw, loc) => {
    var seed = await derive(username, pw)
    me = new Me()
    await me.init(username, seed)

    var user = await (User.create({
      pubkey: me.pubkey,
      username: username,
      nonce: 0,
      balance: 500000
    }))

    l(username + ' : ' + pw + ' at ' + loc)

    K.members.push({
      id: user.id,

      username: username,
      location: loc,

      pubkey: toHex(me.pubkey),
      block_pubkey: me.block_pubkey,

      missed_blocks: [],

      shares: 0
    })
    return seed
  }

  var base = genesis == 'test' ? 'ws://0.0.0.0:' : 'wss://failsafe.network:'

  var seed = await createMember('root', toHex(crypto.randomBytes(16)), base + 8000)

  for (var i = 8001; i < 8005; i++) {
    await createMember(i.toString(), 'password', base + (i + 10))
  }

  K.members[0].shares = 10
  K.members[1].shares = 10
  K.members[2].shares = 6
  K.members[3].shares = 4

  K.members[0].hub = {
    handle: 'eu',
    name: '@eu (Europe-based)'
  }

  K.members[1].hub = {
    handle: 'jp',
    name: '@jp (Asia-based)'
  }

/*
  K.members[2].hub = {
    handle: 'us',
    name: '@us (America-based)'
  }
  
  K.members[3].hub = {
    handle: 'bad',
    name: '@bad (Tries To Hack You)'
  }
  */

  var json = stringify(K)
  fs.writeFileSync('data/k.json', json)

  fs.writeFileSync('private/pk.json', JSON.stringify({
    username: 'root',
    seed: seed.toString('hex'),
    auth_code: toHex(crypto.randomBytes(32))
  }))

  process.exit(0)
}
