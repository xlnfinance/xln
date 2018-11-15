// Onchain database - every full node has the exact same copy
const Sequelize = require('sequelize')

const defineModels = (sequelize) => {
  const User = sequelize.define(
    'user',
    {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },

      // Fair Names /^(\w){1,15}$/)
      username: Sequelize.STRING,

      // saves time to select Debts
      has_debts: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },

      pubkey: Sequelize.CHAR(32).BINARY,

      batch_nonce: {type: Sequelize.INTEGER, defaultValue: 0}
    },
    {
      indexes: [
        {
          fields: [{attribute: 'pubkey', length: 32}]
        }
      ]
    }
  )

  // stores high-level data about bidirectional relationship
  const Insurance = sequelize.define(
    'insurance',
    {
      leftId: Sequelize.INTEGER,
      rightId: Sequelize.INTEGER,

      // for instant withdrawals, increase one by one
      withdrawal_nonce: {type: Sequelize.INTEGER, defaultValue: 0},

      // increased offchain. When disputed, higher one is true
      dispute_nonce: Sequelize.INTEGER,

      dispute_delayed: Sequelize.INTEGER,
      // actual state proposed, rlp-encoded
      dispute_state: Sequelize.TEXT,
      // started by left user?
      dispute_left: Sequelize.BOOLEAN
    },
    {
      indexes: [
        {
          fields: ['leftId', 'rightId']
        }
      ]
    }
  )

  // stores actual insurance balances, per-asset
  const Subinsurance = sequelize.define(
    'subinsurance',
    {
      asset: {type: Sequelize.INTEGER, defaultValue: 1},
      balance: {type: Sequelize.BIGINT, defaultValue: 0},

      // moved when touched by left user
      ondelta: {type: Sequelize.BIGINT, defaultValue: 0}
    },
    {
      indexes: [
        {
          fields: ['asset']
        }
      ]
    }
  )

  const Proposal = sequelize.define('proposal', {
    desc: Sequelize.TEXT,
    code: Sequelize.TEXT,
    patch: Sequelize.TEXT,

    delayed: Sequelize.INTEGER, //cron

    kindof: Sequelize.STRING
  })

  const Vote = sequelize.define('vote', {
    rationale: Sequelize.TEXT,
    approval: Sequelize.BOOLEAN // approval or denial
  })

  const Debt = sequelize.define('debt', {
    asset: Sequelize.INTEGER,
    amount_left: Sequelize.INTEGER,
    oweTo: Sequelize.INTEGER
  })

  // onchain balances (w/o bank)
  const Balance = sequelize.define('balance', {
    asset: {type: Sequelize.INTEGER, defaultValue: 1},

    balance: {type: Sequelize.BIGINT, defaultValue: 0}
  })

  const Order = sequelize.define('order', {
    amount: Sequelize.INTEGER,
    rate: Sequelize.FLOAT
  })

  // Hashlocks is like an evidence guarantee: if you have the secret before exp you unlock the action
  // Primarily used in atomic swaps and mediated transfers. Based on Sprites concept
  // They are are stored for a few days and unlock a specific action
  const Hashlock = sequelize.define(
    'hashlock',
    {
      alg: Sequelize.INTEGER, // sha256, sha3?
      hash: Sequelize.BLOB,
      revealed_at: Sequelize.INTEGER,
      delete_at: Sequelize.INTEGER
    },
    {
      indexes: [
        {
          fields: [{attribute: 'hash', length: 32}]
        }
      ]
    }
  )

  // Assets represent all numerical balances: currencies, tokens, shares, stocks.
  // Anyone can create a new asset
  const Asset = sequelize.define('asset', {
    ticker: Sequelize.TEXT,
    name: Sequelize.TEXT,
    desc: Sequelize.TEXT,

    // division point for min unit, 0 for yen 2 for dollar
    division: Sequelize.INTEGER,

    issuable: Sequelize.BOOLEAN,
    issuerId: Sequelize.INTEGER,
    total_supply: Sequelize.INTEGER
  })

  Insurance.hasMany(Subinsurance)
  Subinsurance.belongsTo(Insurance)

  User.hasMany(Debt)
  Debt.belongsTo(User)

  User.hasMany(Balance)
  Balance.belongsTo(User)

  Asset.hasMany(Order)
  Asset.hasMany(Order, {as: 'buyAsset', foreign_key: 'buyAsset'})

  User.hasMany(Order)
  Order.belongsTo(User)
  Order.belongsTo(Asset)
  Order.belongsTo(Asset, {as: 'buyAsset'})

  Proposal.belongsTo(User)
  Proposal.belongsToMany(User, {through: Vote, as: 'voters'})

  return {
    User: User,
    Insurance: Insurance,
    Subinsurance: Subinsurance,

    Proposal: Proposal,
    Vote: Vote,
    Debt: Debt,
    Order: Order,
    Hashlock: Hashlock,
    Asset: Asset,
    Balance: Balance
  }
}

const getDBConfig = (datadir) => {
  const fullPath = datadir + '/onchain/db.sqlite'
  const logger = (str, time) => {
    if (parseInt(time) > 300) {
      loff(time + ' (on) ' + str)
    }
  }

  const config = {
    dialect: 'sqlite',
    storage: fullPath,
    define: {timestamps: false},
    operatorsAliases: false,
    logging: logger,
    benchmark: true
  }

  const database = ''
  const username = ''
  const password = 'password'

  return [database, username, password, config]
}

class OnchainDB {
  constructor(datadir, force) {
    this.datadir = datadir
    this.force = force || false
  }

  init() {
    l('Initializing onchain db from', this.datadir)

    const [database, username, password, config] = getDBConfig(this.datadir)
    this.db = new Sequelize(database, username, password, config)
    this.models = defineModels(this.db)

    Object.freeze(this)

    return this.db.sync({force: this.force})
  }
}

module.exports = OnchainDB
