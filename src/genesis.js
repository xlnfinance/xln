
// http://ipinfo.io/ip
module.exports = async (opts) => {
  l('Start genesis')

  await (sequelize.sync({force: true}))

  opts = Object.assign({
    username: 'root'
    // infra: 'https://www.digitalocean.com'
  }, opts)

  opts.pw = toHex(crypto.randomBytes(16))

  l(opts.pw)

  // entity / country / infra

  var seed = await derive(opts.username, opts.pw)
  delete (opts.pw)

  me = new Me()
  await me.init(opts.username, seed)

  var user = await (User.create({
    pubkey: bin(me.id.publicKey),
    username: opts.username,
    nonce: 0,
    balance: 100000000
  }))

  // extra user for demo
  var seed2 = await derive('8001', 'password')
  me2 = new Me()
  await me2.init('8001', seed2)

  var user2 = await (User.create({
    pubkey: bin(me2.id.publicKey),
    username: '8001',
    nonce: 0,
    balance: 500000
  }))



  await (Insurance.create({
    userId: 2,
    hubId: 1,
    nonce: 0,
    insurance: 500000,
    rebalanced: 0,
    assetType: 0
  }))

  K = {
    // global network pepper to protect derivation from rainbow tables
    network_name: opts.username,

    usable_blocks: 0,
    total_blocks: 0,
    total_tx: 0,
    total_bytes: 0,

    total_tx_bytes: 0,

    voting_period: 10,

    bytes_since_last_snapshot: 999999999, // force to do a snapshot on first block
    last_snapshot_height: 0,
    snapshot_after_bytes: 100000,
    proposals_created: 0,

    tax: 2,

    account_creation_fee: 100,
    standalone_balance: 500, // keep $5 on your own balance for onchain tx fees

    blocksize: 200000,
    blocktime: 20,

    // each genesis is randomized
    prev_hash: toHex(crypto.randomBytes(32)), // toHex(Buffer.alloc(32)),

    risk: 10000, // recommended rebalance limit
    hard_limit: 1000000, // how much can a user lose if hub is insolvent?


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
        total_supply: user.balance
      },
      {
        ticker: 'FSB',
        name: 'Bond',
        total_supply: 0
      }
    ],

    members: [],
    total_shares: 15,
    majority: 11,

    hubs: []
  }

  K.members.push({
    id: user.id,

    username: opts.username,
    location: opts.location,

    pubkey: toHex(me.id.publicKey),
    block_pubkey: me.block_pubkey,


    missed_blocks: [],
    shares: 10,

    hub: {
      name: '1'
    }
  })

  var loc2 = opts.location.split(':')

  K.members.push({
    id: user2.id,

    username: '8001',
    location: 'ws:' + loc2[1] + ':' + (parseInt(loc2[2])+10),

    pubkey: toHex(me2.id.publicKey),
    block_pubkey: me2.block_pubkey,

    missed_blocks: [],

    shares: 5,
  })

  var json = stringify(K)
  fs.writeFileSync('data/k.json', json)

  fs.writeFileSync('private/pk.json', JSON.stringify({
    username: opts.username,
    seed: seed.toString('hex'),
    auth_code: toHex(crypto.randomBytes(32))
  }))

  process.exit(0)
}
