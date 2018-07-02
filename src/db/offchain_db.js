// Offchain database - local and private stuff
if (argv.db) {
  let db_info = argv.db.split(':')
  let db_pool = argv['db-pool'] || 1
  var base_db = {
    dialect: db_info[0],
    host: '127.0.0.1',
    define: {timestamps: true}, // we don't mind timestamps in offchain db
    operatorsAliases: false,

    logging: (str, time) => {
      if (parseInt(time) > 300) {
        loff(time + ' (off) ' + str)
      }
    },
    benchmark: true,

    retry: {
      max: 10
    },
    pool: {
      max: db_pool,
      min: 0,
      acquire: 20000,
      idle: 20000,
      evict: 30000,
      handleDisconnects: true
    }
  }

  /* Helpful stats:
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
  privSequelize = new Sequelize(datadir, db_info[1], db_info[2], base_db)
} else {
  var base_db = {
    dialect: 'sqlite',
    // dialectModulePath: 'sqlite3',
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
  privSequelize = new Sequelize('root', 'root', '', base_db)
}

// ensure db exists
//privSequelize.query('CREATE DATABASE ' + datadir).catch(l)

l('Reading and syncing offchain db: ' + base_db.dialect)
// Encapsulates relationship with counterparty: offdelta and last signatures
// TODO: seamlessly cloud backup it. If signatures are lost, money is lost

// we name our things "value", and counterparty's "they_value"
Delta = privSequelize.define(
  'delta',
  {
    // between who and who
    myId: Sequelize.BLOB,
    partnerId: Sequelize.BLOB,

    // higher nonce is valid
    nonce: Sequelize.INTEGER,
    status: Sequelize.ENUM(
      'master',
      'sent',
      'merge',
      'disputed',
      'CHEAT_dontack'
    ),

    pending: Sequelize.BLOB,

    // TODO: clone from Insurance table to Delta to avoid double querying both dbs
    disbalance: Sequelize.INTEGER,

    offdelta: Sequelize.INTEGER,
    asset: {
      type: Sequelize.INTEGER,
      defaultValue: 1
    },

    soft_limit: Sequelize.INTEGER,
    hard_limit: Sequelize.INTEGER, // we trust up to

    they_soft_limit: Sequelize.INTEGER,
    they_hard_limit: Sequelize.INTEGER, // they trust us

    flush_requested_at: Sequelize.DATE,
    ack_requested_at: Sequelize.DATE,
    last_online: Sequelize.DATE,
    withdrawal_requested_at: Sequelize.DATE,

    they_input_amount: Sequelize.INTEGER,

    input_amount: Sequelize.INTEGER,
    input_sig: Sequelize.BLOB, // we store a withdrawal sig to use in next rebalance

    sig: Sequelize.BLOB,
    signed_state: Sequelize.BLOB,

    signed_nonce: Sequelize.INTEGER,
    signed_offdelta: Sequelize.INTEGER,

    // All the safety Byzantine checks start with cheat_
    CHEAT_profitable_state: Sequelize.BLOB,
    CHEAT_profitable_sig: Sequelize.BLOB,

    // 4th type of balance, equivalent traditional balance in a bank. For pocket change.
    // Exists for convenience like pulling payments when the user is offline.
    trusted_frd: {
      type: Sequelize.INTEGER,
      defaultValue: 0
    }
  },
  {
    indexes: [
      {
        fields: [
          {
            attribute: 'partnerId',
            length: 32
          },
          {
            attribute: 'asset'
          }
        ]
      }
    ]
  }
)

Payment = privSequelize.define(
  'payment',
  {
    //todo: move to single field addnew, addsent ...
    type: Sequelize.ENUM('add', 'del', 'addrisk', 'delrisk'),
    status: Sequelize.ENUM('new', 'sent', 'ack'),
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
    // secret that unlocks hash
    secret: Sequelize.BLOB,

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
    refund_address: Sequelize.TEXT,

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

Delta.hasMany(Payment)
Payment.belongsTo(Delta)

Payment.prototype.toLock = function() {
  return [this.amount, this.hash, this.exp]
}

Delta.prototype.verify = function(state, ackSig) {
  // canonical state representation
  var canonical = r(state)
  if (ec.verify(canonical, ackSig, this.partnerId)) {
    if (trace)
      l(`Successfully verified sig against state\n${ascii_state(state)}`)

    this.sig = ackSig
    this.signed_state = canonical
    return true
  } else {
    return false
  }
}

Delta.prototype.requestFlush = async function() {
  if (!this.flush_requested_at) {
    //this.flush_requested_at = new Date()
    //await this.save()
    await me.flushChannel(this.partnerId, 1, true)
  }
}

Delta.prototype.getDispute = async function() {
  // post last sig if any
  var partner = await User.idOrKey(this.partnerId)

  // the user is not even registered (we'd have to register them first)
  var id = partner.id ? partner.id : this.partnerId
  return this.sig ? [id, this.sig, this.signed_state] : [id]
}

Delta.prototype.startDispute = async function(cheat = false) {
  if (cheat && this.CHEAT_profitable_state) {
    var d = [
      this.partnerId,
      this.CHEAT_profitable_sig,
      this.CHEAT_profitable_state
    ]
  } else {
    var d = await this.getDispute()
  }
  this.status = 'disputed'
  me.batch.push(['disputeWith', this.asset, [d]])
  await this.save()
}

Delta.prototype.getChannel = async function() {
  return await me.getChannel(this.partnerId, this.asset, this)
}

// used primarily by validators and explorers to store historical blocks. Regular users don't have to store blocks ("pruning" mode)

Block = privSequelize.define(
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
