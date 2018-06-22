// this file is only used during genesis to set initial K params and create first validators

module.exports = async () => {
  l('Start genesis')

  try {
    await sequelize.sync({force: true})
  } catch (err) {
    l(errmsg(`Cannot sync DB ${highlight(sequelize.options.storage)}`))
    throw err
  }

  // K is a handy config JSON
  K = {
    // global network pepper to protect derivation from rainbow tables
    network_name: 'main',

    usable_blocks: 0, // blocks that have some extra space (to ensure disputes add on-time)
    total_blocks: 0, // total number of blocks full or not

    total_tx: 0,
    total_bytes: 0,

    total_tx_bytes: 0,

    voting_period: 10,

    current_db_hash: '',

    bytes_since_last_snapshot: 999999999, // force to do a snapshot on first block
    last_snapshot_height: 0,
    snapshot_after_bytes: 1000000,
    proposals_created: 0,

    // cents per byte of tx
    tax: 1,

    // manually priced actions to prevent spam
    account_creation_fee: 100,
    standalone_balance: 500, // keep $5 on your own balance for unexpected onchain fees

    blocksize: 100000,
    blocktime: 20,
    step_latency: 5, // how long is each consensus step: propose, prevote, precommit, await is the rest
    gossip_delay: 1500, // anti clock skew, give others time to change state

    // up to X seconds, validators don't propose blocks if empty
    // the problem is all delayed actions also happen much later if no blocks made
    skip_empty_blocks: 0,

    // each genesis is randomized
    prev_hash: toHex(crypto.randomBytes(32)), // toHex(Buffer.alloc(32)),

    risk: 10000, // recommended rebalance limit
    hard_limit: 100000000, // how much can a user lose if hub is insolvent?

    collected_tax: 0,

    // latest block done at
    ts: 0,

    
    //Time.at(1913370000) => 2030-08-19 20:40:00 +0900
    
    bet_maturity: ts() + 100, // when all FRB turn into FRD
    created_at: ts(),

    // sanity limits for offchain payments
    min_amount: 10,
    max_amount: 300000000,

    members: [],
    hubs: [],
    flush_timeout: 250,

    cache_timeout: 120, // keep channel in memory since last use
    safe_sync_delay: 60, // after what time prohibit using wallet if unsynced
    sync_limit: 500,   // how many blocks to share at once


    // global wide fee sanity limits
    min_fee: 1,
    max_fee: 5000,

    // hashlock and dispute-related
    secret_len: 32,
    dispute_delay: 8, // in how many blocks disputes are considered final
    hashlock_exp: 4, // how many blocks a user needs to be a able to reveal
    hashlock_keepalive: 100, // for how many blocks onchain keeps it unlocked since reveal (it takes space on all fullnodes, so it must be deleted eventually)
    max_hashlocks: 5000, // we don't want overweight huge dispute strings
    hashlock_service_fee: 100, // the one who adds hashlock pays for it
    dispute_if_no_ack: 40000 // ms, how long we wait for ack before going to blockchain
  }

  // Defines global Byzantine tolerance parameter
  // 0 would require 1 validator, 1 - 4, 2 - 7.
  // Long term goal is 3333 tolerance with 10,000 validators
  K.tolerance = 1

  K.total_shares = K.tolerance * 3 + 1

  K.majority = K.total_shares - K.tolerance

  // members provide services: 1) build blocks 2) hubs 3) watchers 4) storage of vaults

  createMember = async (username, pw, loc, website) => {
    var seed = await derive(username, pw)
    me = new Me()
    await me.init(username, seed)

    var user = await User.create({
      pubkey: me.pubkey,
      username: username,
      nonce: 0,
      balance1: 10000000000,
      balance2: 10000000000,
      balances: `{"3": 10000000000}`
    })


    l(`${username} : ${pw} at ${loc}`)

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

    if (user.id != 1) {
      var left =
        Buffer.compare(
          user.pubkey,
          fromHex(K.members[0].pubkey)
        ) == -1

      // preload channel FRD and FRB
      await Insurance.create({
        leftId: left ? user.id : 1,
        rightId: left ? 1 : user.id,
        insurance: 1000000,
        ondelta: left ? 1000000 : 0,
        nonce: 0,
        asset: 1
      })

      await Insurance.create({
        leftId: left ? user.id : 1,
        rightId: left ? 1 : user.id,
        insurance: 2000000,
        ondelta: left ? 2000000 : 0,
        nonce: 0,
        asset: 2
      })
    }

    return seed
  }

  let local = !argv['prod-server']

  var base_rpc = local ? 'ws://' + localhost : 'wss://fairlayer.com'
  var base_web = local ? 'http://' + localhost : 'https://fairlayer.com'

  l(note('New members:'))
  var seed = await createMember(
    'root',
    toHex(crypto.randomBytes(16)),
    `${base_rpc}:8100`,
    local ? 'http://' + localhost + ':8433' : 'https://fairlayer.com'
  )

  for (var i = 8001; i < 8004; i++) {
    await createMember(
      i.toString(),
      'password',
      `${base_rpc}:${i + 100}`,
      `${base_web}:${i}`
    )
  }

  K.members[0].shares = 1
  K.members[0].platform = 'Digital Ocean SGP1'

  K.members[1].shares = 1
  K.members[1].platform = 'AWS'

  K.members[2].shares = 1
  K.members[2].platform = 'Azure'

  K.members[3].shares = 1
  K.members[3].platform = 'Google Cloud'

  K.hubs.push({
    id: K.members[0].id,
    location: K.members[0].location,
    pubkey: K.members[0].pubkey,

    fee: 0.008,

    handle: 'main',
    name: '@main (Main)'
  })

  /*
  K.hubs.push({
    id: K.members[3].id,
    location: K.members[3].location,
    pubkey: K.members[3].pubkey,

    fee: 0.005,

    handle: 'jp',
    name: '@jp (Japan)'
  })*/

  await Asset.create({
    ticker: 'FRD',
    name: 'Dollar',
    desc: 'Fair Dollar',
    issuerId: 1,
    total_supply: 1000000000
  })

  await Asset.create({
    ticker: 'FRB',
    name: 'Bet',
    desc: 'Fair Bet',
    issuerId: 1,
    total_supply: 1000000000
  })

  /*
  K.members[2].hub = {
    handle: 'us',
    name: '@us (America-based)'
  }
*/

  var json = stringify(K)
  await promise_writeFile('./'+datadir + '/onchain/k.json', json)

  await promise_writeFile(
    datadir + '/offchain/pk.json',
    JSON.stringify({
      username: 'root',
      seed: seed.toString('hex'),
      auth_code: toHex(crypto.randomBytes(32)),
      pending_batch: null
    })
  )

  l('Genesis done ('+datadir+'), quitting')

  // not graceful to not trigger hooks
  process.exit(0)
}
