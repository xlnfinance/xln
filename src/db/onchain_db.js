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
      nonce: {type: Sequelize.INTEGER, defaultValue: 0},

      // FRD and FRB have dedicated db field
      balance1: {type: Sequelize.BIGINT, defaultValue: 0},
      balance2: {type: Sequelize.BIGINT, defaultValue: 0},
      // all other assets, serialized
      balances: {type: Sequelize.TEXT}
    },
    {
      indexes: [
        {
          fields: [{attribute: 'pubkey', length: 32}]
        }
      ]
    }
  )

  const Insurance = sequelize.define(
    'insurance',
    {
      leftId: Sequelize.INTEGER,
      rightId: Sequelize.INTEGER,

      // for instant withdrawals, increase one by one
      nonce: {type: Sequelize.INTEGER, defaultValue: 0},
      asset: {type: Sequelize.INTEGER, defaultValue: 1},

      insurance: {type: Sequelize.BIGINT, defaultValue: 0},

      // what hub had already insured
      ondelta: {type: Sequelize.BIGINT, defaultValue: 0},

      dispute_delayed: Sequelize.INTEGER,

      // increased offchain. When disputed, higher one is true
      dispute_nonce: Sequelize.INTEGER,
      dispute_offdelta: Sequelize.INTEGER,

      // two arrays of hashlocks, inwards for left and inwards for right
      dispute_hashlocks: Sequelize.TEXT,

      // started by left user?
      dispute_left: Sequelize.BOOLEAN
    },
    {
      indexes: [
        {
          fields: ['leftId', 'rightId', 'asset']
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

  Debt.belongsTo(User)

  User.hasMany(Debt)
  User.hasMany(Order)

  Asset.hasMany(Order)
  Asset.hasMany(Order, {as: 'buyAsset', foreign_key: 'buyAsset'})

  Order.belongsTo(User)
  Order.belongsTo(Asset)
  Order.belongsTo(Asset, {as: 'buyAsset'})

  Proposal.belongsTo(User)
  Proposal.belongsToMany(User, {through: Vote, as: 'voters'})

  return {
    User: User,
    Insurance: Insurance,
    Proposal: Proposal,
    Vote: Vote,
    Debt: Debt,
    Order: Order,
    Hashlock: Hashlock,
    Asset: Asset
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
