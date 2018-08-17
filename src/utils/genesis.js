// this file is only used during genesis to set initial K params and create first validators
const derive = require('./derive')

const createValidator = async (username, pw, loc, website) => {
  l(`${username} : ${pw} at ${loc}`)

  const seed = await derive(username, pw)
  const me = new Me()
  await me.init(username, seed)

  const user = await User.create({
    pubkey: me.pubkey,
    username: username,
    nonce: 0,
    balance1: 10000000000,
    balance2: 10000000000,
    balances: `{"3": 10000000000}`
  })

  const validator = {
    id: user.id,
    username: username,
    location: loc,
    website: website,
    pubkey: toHex(me.pubkey),
    block_pubkey: me.block_pubkey,
    missed_blocks: [],
    shares: 0
  }

  return [validator, seed]
}

const writeGenesisOnchainConfig = async (k, datadir) => {
  await promise_writeFile('./' + datadir + '/onchain/k.json', stringify(k))
}

const writeGenesisOffchainConfig = async (pk, datadir) => {
  await promise_writeFile('./' + datadir + '/offchain/pk.json', stringify(pk))
}

module.exports = async (datadir) => {
  l('Start genesis')

  // K is a handy config JSON
  const K = {
    // Things that are different in testnet vs mainnet
    network_name: 'testnet',
    blocksize: 100000,
    blocktime: 6,
    step_latency: 1, // how long is each consensus step: propose, prevote, precommit, await is the rest
    gossip_delay: 200, // anti clock skew, give others time to change state

    //Time.at(1913370000) => 2030-08-19 20:40:00 +0900

    bet_maturity: ts() + 100, // when all FRB turn into FRD
    created_at: ts(),

    usable_blocks: 0, // blocks that have some extra space (to ensure disputes add on-time)
    total_blocks: 0, // total number of blocks full or not

    total_tx: 0,
    total_bytes: 0,

    total_tx_bytes: 0,

    voting_period: 10,

    current_db_hash: '',

    blocks_since_last_snapshot: 999999999, // force to do a snapshot on first block
    last_snapshot_height: 0,

    snapshot_after_blocks: 100, // something like every hour is good enough
    snapshots_taken: 0,
    proposals_created: 0,

    // cents per byte of tx
    min_gasprice: 1,

    // manually priced actions to prevent spam
    account_creation_fee: 100,

    standalone_balance: 1000, // keep $10 on your own balance for unexpected onchain fees
    hub_standalone_balance: 100000, // hub has higher operational costs, so $1k is safer for unexpected onchain fees

    // up to X seconds, validators don't propose blocks if empty
    // the problem is all delayed actions also happen much later if no blocks made
    skip_empty_blocks: 0,

    // each genesis is randomized
    prev_hash: toHex(crypto.randomBytes(32)), // toHex(Buffer.alloc(32)),

    risk: 10000, // hubs usually withdraw after this amount

    soft_limit: 5000000, // rebalance after
    hard_limit: 50000000, // how much can a user lose if hub is insolvent?

    collected_fees: 0,

    // latest block done at
    ts: 0,

    assets_created: 2,

    // sanity limits for offchain payments
    min_amount: 5,
    max_amount: 300000000,

    validators: [],
    hubs: [],
    flush_timeout: 250,

    cache_timeout: 60, //s, keep channel in memory since last use
    safe_sync_delay: 60, //s, after what time prohibit using wallet if unsynced
    sync_limit: 500, // how many blocks to share at once

    // global wide fee sanity limits
    min_fee: 1,
    max_fee: 5000,

    // hashlock and dispute-related
    secret_len: 32,
    dispute_delay: 8, // in how many blocks disputes are considered final
    hashlock_exp: 16, // how many blocks (worst case scenario) a user needs to be a able to reveal secret
    hashlock_keepalive: 100, // for how many blocks onchain keeps it unlocked since reveal (it takes space on all fullnodes, so it must be deleted eventually)
    max_hashlocks: 20, // we don't want overweight huge dispute strings
    hashlock_service_fee: 100, // the one who adds hashlock pays for it

    // ensure it is much shorter than hashlock_exp
    dispute_if_no_ack: 60000 // ms, how long we wait for ack before going to blockchain
  }

  // Defines global Byzantine tolerance parameter
  // 0 would require 1 validator, 1 - 4, 2 - 7.
  // Long term goal is 3333 tolerance with 10,000 validators
  K.tolerance = 1

  K.total_shares = K.tolerance * 3 + 1

  K.majority = K.total_shares - K.tolerance

  const local = !argv['prod-server']

  const base_rpc = local ? 'ws://' + localhost : 'wss://fairlayer.com'
  const base_web = local ? 'http://' + localhost : 'https://fairlayer.com'

  // validators provide services: 1) build blocks 2) hubs 3) watchers 4) storage of vaults
  l(note('New validators:'))

  // create hub
  const [hubValidator, hubSeed] = await createValidator(
    'root',
    toHex(crypto.randomBytes(16)),
    `${base_rpc}:8100`,
    local ? 'http://' + localhost + ':8433' : 'https://fairlayer.com'
  )
  K.validators.push(hubValidator)

  // create other validators
  for (const i of [8001, 8002, 8003]) {
    const [validator, _] = await createValidator(
      i.toString(),
      'password',
      `${base_rpc}:${i + 100}`,
      `${base_web}:${i}`
    )

    const left =
      Buffer.compare(fromHex(validator.pubkey), fromHex(hubValidator.pubkey)) ==
      -1

    K.validators.push(validator)

    // preload channel FRD and FRB
    await Insurance.create({
      leftId: left ? validator.id : 1,
      rightId: left ? 1 : validator.id,
      insurance: 1000000,
      ondelta: left ? 1000000 : 0,
      nonce: 0,
      asset: 1
    })

    await Insurance.create({
      leftId: left ? validator.id : 1,
      rightId: left ? 1 : validator.id,
      insurance: 2000000,
      ondelta: left ? 2000000 : 0,
      nonce: 0,
      asset: 2
    })
  }

  // distribute shares
  K.validators[0].shares = 1
  K.validators[0].platform = 'Digital Ocean SGP1'

  K.validators[1].shares = 1
  K.validators[1].platform = 'AWS'

  K.validators[2].shares = 1
  K.validators[2].platform = 'Azure'

  K.validators[3].shares = 1
  K.validators[3].platform = 'Google Cloud'

  // set hub
  K.hubs.push({
    id: K.validators[0].id,
    location: K.validators[0].location,
    pubkey: K.validators[0].pubkey,

    fee: 0.001,

    handle: 'main',
    name: '@main (Main)'
  })

  /*
  K.hubs.push({
    id: K.validators[3].id,
    location: K.validators[3].location,
    pubkey: K.validators[3].pubkey,

    fee: 0.005,

    handle: 'second',
    name: '@second (Second)'
  })
  */

  await Asset.create({
    ticker: 'FRD',
    name: 'Fair Dollar',
    desc:
      'Fair Dollar is a fiat currency issued by Fair Foundation. It is collateralized and easy to sell for traditional fiat currencies at stable exchange rate.',
    issuerId: 1,
    total_supply: 1000000000
  })

  await Asset.create({
    ticker: 'FRB',
    name: 'Fair Bet',
    desc:
      'Fair Bet supply is capped at 100B FRB. FRB will be automatically converted into FRD 1-for-1 on 2030-08-19.',
    issuerId: 1,
    total_supply: 1000000000
  })

  /*
  K.validators[2].hub = {
    handle: 'us',
    name: '@us (America-based)'
  }
  */

  const PK = {
    username: 'root',
    seed: hubSeed.toString('hex'),
    auth_code: toHex(crypto.randomBytes(32)),
    pending_batch: null
  }

  await writeGenesisOnchainConfig(K, datadir)
  await writeGenesisOffchainConfig(PK, datadir)

  l('Genesis done (' + datadir + '), quitting')

  // not graceful to not trigger hooks
  process.exit(0)
}
