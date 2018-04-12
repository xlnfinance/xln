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
    snapshot_after_bytes: 1000000,
    proposals_created: 0,

    tax: 1,

    account_creation_fee: 100,
    standalone_balance: 500, // keep $5 on your own balance for unexpected onchain fees

    blocksize: 20000,
    blocktime: 20,


    // each genesis is randomized
    prev_hash: toHex(crypto.randomBytes(32)), // toHex(Buffer.alloc(32)),

    risk: 10000, // recommended rebalance limit
    hard_limit: 100000, // how much can a user lose if hub is insolvent?

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
    hubs: []
  }

  // Defines global Byzantine tolerance parameter
  // 0 would require 1 validator, 1 - 4, 2 - 7. 
  // Our final goal is at least 3333 tolerance with 10,000 validators
  K.tolerance = 1 


  K.total_shares = K.tolerance * 3 + 1 


  K.majority = K.total_shares - K.tolerance
  //K.total_shares%3==0?K.total_shares*2/3+1:Math.ceil(K.total_shares*2/3)


  // members provide services: 1) build blocks 2) hubs 3) watchers 4) storage of vaults

  createMember = async (username, pw, loc, website) => {
    var seed = await derive(username, pw)
    me = new Me()
    await me.init(username, seed)

    var user = await (User.create({
      pubkey: me.pubkey,
      username: username,
      nonce: 0,
      balance: 500000000
    }))

    l(username + ' : ' + pw + ' at ' + loc)

    K.members.push({
      id: user.id,

      username: username,

      location: loc,
      website: website,

      pubkey: toHex(me.pubkey),
      block_pubkey: me.block_pubkey,

      missed_blocks: [],

      shares: 0
    })
    return seed
  }

  var local = !fs.existsSync('/etc/letsencrypt/live/failsafe.network/fullchain.pem')

  var base_rpc = local ? 'ws://'+localhost : 'wss://failsafe.network'
  var base_web = local ? 'http://'+localhost : 'https://failsafe.network'

  var seed = await createMember('root', toHex(crypto.randomBytes(16)),
    `${base_rpc}:8100`,
    local ? 'http://'+localhost+':8433' : 'https://failsafe.network'
    )

  for (var i = 8001; i < 8004; i++) {
    await createMember(i.toString(), 'password', `${base_rpc}:${i + 100}`, `${base_web}:${i}`)
  }

  K.members[0].shares = 1
  K.members[0].platform = 'Digital Ocean SGP1'

  K.members[1].shares = 1
  K.members[1].platform = 'AWS'

  K.members[2].shares = 1
  K.members[2].platform = 'Azure'

  K.members[3].shares = 1
  K.members[3].platform = 'Google Cloud'



  K.members[0].hub = {
    handle: 'eu',
    name: '@eu (Europe)'
  }

  K.members[3].hub = {
    handle: 'jp',
    name: '@jp (Japan)'
  }



  K.hubs.push({
    id: K.members[0].id,
    location: K.members[0].location,
    pubkey: K.members[0].pubkey,

    handle: 'eu',
    name: '@eu (Europe)'
  })




  // preload 2@3 channel 
  await Insurance.create({
    leftId: 2,
    rightId: 1,
    insurance: 1000000,
    ondelta: 1000000,
    nonce: 0
  })

/*
  K.members[2].hub = {
    handle: 'us',
    name: '@us (America-based)'
  }
*/

  var json = stringify(K)
  fs.writeFileSync('data/k.json', json)

  fs.writeFileSync('private/pk.json', JSON.stringify({
    username: 'root',
    seed: seed.toString('hex'),
    auth_code: toHex(crypto.randomBytes(32)),
    pending_tx: []
  }))

  process.exit(0)
}
