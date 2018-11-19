// Offchain database - local and private stuff

/*
Helpful stats:
show status like '%used_connections%';
show variables like 'max_connections';
show variables like 'open_files_limit';
ulimit -n 10000

Set new mysql pw:
use mysql;
update user set authentication_string=password(''), plugin='mysql_native_password' where user='root';
ALTER USER 'root'@'%' IDENTIFIED WITH mysql_native_password BY '123123';
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '123123';
SELECT plugin FROM mysql.user WHERE User = 'root';

Create databases before usage in simulation:

str = 'create database data;'
for(i=8001;i<8200;i++){
  str+='create database data'+i+';'
}
*/

const Sequelize = require('sequelize')

const defineModels = (sequelize) => {
  // Encapsulates relationship with counterparty: offdelta and last signatures
  // TODO: seamlessly cloud backup it. If signatures are lost, money is lost

  // we name our things "value", and counterparty's "they_value"
  const Channel = sequelize.define(
    'channel',
    {
      // between who and who
      myId: Sequelize.BLOB,
      partnerId: Sequelize.BLOB,

      // higher nonce is valid
      dispute_nonce: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },

      // used during rollbacks
      rollback_nonce: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },

      status: {
        type: Sequelize.ENUM(
          'master',
          'sent',
          'merge',
          'disputed',
          'CHEAT_dontack'
        ),
        defaultValue: 'master'
      },

      pending: Sequelize.BLOB,

      ack_requested_at: {
        type: Sequelize.DATE,
        defaultValue: null
      },

      last_online: Sequelize.DATE,
      withdrawal_requested_at: Sequelize.DATE,

      sig: Sequelize.BLOB,
      signed_state: Sequelize.BLOB,

      // All the safety Byzantine checks start with cheat_
      CHEAT_profitable_state: Sequelize.BLOB,
      CHEAT_profitable_sig: Sequelize.BLOB
    },
    {
      indexes: [
        {
          fields: [
            {
              attribute: 'partnerId',
              length: 32
            }
          ]
        }
      ]
    }
  )

  // each separate offdelta per asset
  const Subchannel = sequelize.define(
    'subchannel',
    {
      asset: {
        type: Sequelize.INTEGER,
        defaultValue: 1
      },

      offdelta: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },

      rollback_offdelta: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },

      // by default all limits set to 0
      soft_limit: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      hard_limit: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      }, // we trust up to

      they_soft_limit: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      they_hard_limit: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      }, // they trust us

      requested_insurance: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },

      they_requested_insurance: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },

      withdrawal_amount: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },

      withdrawal_sig: Sequelize.BLOB, // we store a withdrawal sig to use in next rebalance

      they_withdrawal_amount: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      }
    },
    {
      indexes: [
        {
          fields: [
            {
              attribute: 'asset'
            }
          ]
        }
      ]
    }
  )

  const Payment = sequelize.define(
    'payment',
    {
      //todo: move to single field addnew, addsent ...
      type: Sequelize.STRING, //ENUM('add', 'del', 'addrisk', 'delrisk', 'onchain'),
      status: Sequelize.STRING, //ENUM('new', 'sent', 'ack'),
      is_inward: Sequelize.BOOLEAN,

      processed: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      }, // did merchant app process this deposit already

      // streaming payments
      lazy_until: Sequelize.DATE,

      // in outward it is inward amount - fee
      amount: Sequelize.INTEGER,
      // hash is same for inward and outward
      hash: Sequelize.BLOB,
      // best by block
      exp: Sequelize.INTEGER,
      // asset type
      asset: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },

      // secret or fail reason
      outcome_type: Sequelize.STRING,
      // payload of outcome
      outcome: Sequelize.BLOB,

      // string to be decrypted by outward
      unlocker: Sequelize.BLOB,

      // user-specified or randomly generated private message
      invoice: Sequelize.BLOB,

      // stored on our node only. can help to identify the reason for payment
      // eg when a withdrawal has failed we credit funds back
      personal_tag: Sequelize.BLOB,

      // who is recipient
      destination_address: Sequelize.TEXT,

      // sender may decide to provide refund address inside the private message
      source_address: Sequelize.TEXT,

      // who caused us to make this payment (if we're hub)?
      inward_pubkey: Sequelize.BLOB
    },
    {
      indexes: [
        {
          fields: ['type', 'status']
        }
      ]
    }
  )

  // used primarily by validators and explorers to store historical blocks.
  // Regular users don't have to store blocks ("pruning" mode)
  const Block = sequelize.define(
    'block',
    {
      hash: Sequelize.BLOB,
      prev_hash: Sequelize.BLOB,

      // sigs that authorize block
      precommits: Sequelize.BLOB,

      // header with merkle roots in it
      header: Sequelize.BLOB,

      // array of tx in block
      ordered_tx_body: Sequelize.BLOB,

      // happened events stored in JSON
      meta: Sequelize.TEXT,
      total_tx: Sequelize.INTEGER
    },
    {
      indexes: [
        {
          fields: [{attribute: 'prev_hash', length: 32}]
        }
      ]
    }
  )

  // const OffchainOrder...

  // a global log/history for current user
  const Event = sequelize.define('event', {
    type: Sequelize.STRING, //ENUM('received', 'sent', 'fee'),
    desc: Sequelize.TEXT,
    data: Sequelize.TEXT,

    amount: Sequelize.INTEGER,
    asset: Sequelize.INTEGER,
    userId: Sequelize.INTEGER, // receiver/sender's id
    blockId: Sequelize.INTEGER, // when it happened
    invoice: Sequelize.BLOB
  })

  // offchain order for instant trustless exchange
  const OffOrder = sequelize.define('offorder', {
    amount: Sequelize.INTEGER,
    rate: Sequelize.FLOAT,
    assetId: Sequelize.INTEGER,
    buyAssetId: Sequelize.INTEGER
  })

  let nonull = {foreignKey: {allowNull: false}, onDelete: 'CASCADE'}

  Channel.hasMany(Subchannel, nonull)
  Subchannel.belongsTo(Channel, nonull)

  Channel.hasMany(Payment, nonull)
  Payment.belongsTo(Channel, nonull)

  Channel.prototype.isLeft = function() {
    return Buffer.compare(me.pubkey, this.partnerId) == -1
  }

  return {
    // actual channel
    Channel: Channel,
    // subchannels (offdeltas for assets)
    Subchannel: Subchannel,
    // hashlocks for offdeltas
    Payment: Payment,
    // user-specific onchain events
    Event: Event,

    Block: Block,
    OffOrder: OffOrder
  }
}

const productionDBConfig = (datadir, dbtoken, dbpool) => {
  const logger = (str, time) => {
    if (parseInt(time) > 300) {
      loff(time + ' (on) ' + str)
    }
  }

  const database = datadir
  const [dialect, username, password] = dbtoken.split(':')
  const config = {
    dialect: dialect,
    host: '127.0.0.1',
    define: {timestamps: true}, // we don't mind timestamps in offchain db
    operatorsAliases: false,
    logging: logger,
    benchmark: true,
    retry: {
      max: 10
    },
    pool: {
      max: dbpool,
      min: 0,
      acquire: 20000,
      idle: 20000,
      evict: 30000,
      handleDisconnects: true
    }
  }

  return [database, username, password, config]
}

const defaultDBConfig = (datadir) => {
  const database = 'root'
  const username = 'root'
  const password = ''

  var config = {
    dialect: 'sqlite',
    storage: datadir + '/offchain/db.sqlite',
    define: {timestamps: true}, // we don't mind timestamps in offchain db
    operatorsAliases: false,
    logging: false,
    retry: {
      max: 20
    },
    pool: {
      max: 10,
      min: 0,
      acquire: 10000,
      idle: 10000
    }
  }

  return [database, username, password, config]
}

const getDBConfig = (datadir, dbtoken, dbpool) => {
  if (dbtoken) {
    return productionDBConfig(datadir, dbtoken, dbpool)
  } else {
    return defaultDBConfig(datadir)
  }
}

class OffchainDB {
  constructor(datadir, dbtoken, pool, force) {
    this.datadir = datadir
    this.dbtoken = dbtoken
    this.pool = pool || 1
    // set to true when updated the schema
    this.force = force || K.total_blocks <= 1
  }

  init() {
    l(
      `Initializing offchain db, datadir ${this.datadir}, dbtoken ${
        this.dbtoken
      }, force ${this.force}`
    )

    const [database, username, password, config] = getDBConfig(
      this.datadir,
      this.dbtoken,
      this.pool
    )

    this.db = new Sequelize(database, username, password, config)
    this.models = defineModels(this.db)

    Object.freeze(this)

    return //this.db.sync({force: this.force})
  }
}

module.exports = OffchainDB
