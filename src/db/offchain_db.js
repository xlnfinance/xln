// Offchain database - local and private stuff
if (argv.db) {
  let db_info = argv.db.split(':')
  var base_db = {
    dialect: db_info[0],
    host: '127.0.0.1',
    define: {timestamps: true}, // we don't mind timestamps in offchain db
    operatorsAliases: false,

    logging: (str, time) => {
      if (parseInt(time) > 200) {
        loff(time + ' (off) ' + str)
      }
    },
    benchmark: true,

    retry: {
      max: 10
    },
    pool: {
      max: base_port == 443 ? 40 : 1,
      min: 0,
      acquire: 10000,
      idle: 10000,
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
    insurance: Sequelize.INTEGER,
    ondelta: Sequelize.INTEGER,

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

    // All the safety Byzantine checks start with cheat_
    CHEAT_profitable_state: Sequelize.BLOB,
    CHEAT_profitable_sig: Sequelize.BLOB,

    // 4th type of balance, equivalent traditional balance in a bank. For pocket change.
    // Exists for convenience like pulling payments when the user is offline.
    custodian_balance: {
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
    type: Sequelize.ENUM(
      'add',
      'settle',
      'fail',
      'addrisk',
      'settlerisk',
      'failrisk'
    ),
    status: Sequelize.ENUM('new', 'sent', 'acked', 'processed'),
    is_inward: Sequelize.BOOLEAN,

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
      defaultValue: 1
    },

    // who is recipient
    destination: Sequelize.BLOB,
    // string to be decrypted by outward
    unlocker: Sequelize.BLOB,

    // user-specified or randomly generated private message
    invoice: Sequelize.BLOB,

    // secret that unlocks hash
    secret: Sequelize.BLOB
  },
  {
    indexes: [
      {
        fields: [
          'type'
          // 'status',
          // 'is_inward'
          /*
          {attribute: 'type', length: 8},
          {attribute: 'status', length: 8}*/
        ]
      },
      {
        fields: ['status']
      }
    ]
  }
)

Delta.hasMany(Payment)
Payment.belongsTo(Delta)
//Delta.hasMany(Payment, {foreignKey: 'delta_id', sourceKey: 'id'})
//Payment.belongsTo(Delta, {foreignKey: 'delta_id', targetKey: 'id'})

Payment.prototype.toLock = function() {
  return [this.amount, this.hash, this.exp]
}

Payment.prototype.getInward = async function() {
  return Payment.findOne({
    where: {hash: this.hash, is_inward: true, asset: this.asset}
  })
}

Delta.prototype.saveState = function(state, ackSig) {
  // canonical state representation
  var canonical = r(state)
  if (ec.verify(canonical, ackSig, this.partnerId)) {
    this.nonce = state[1][2]
    this.offdelta = state[1][3]

    if (this.sig && ackSig.equals(this.sig)) {
      //l(`Already saved ackSig`)
      return true
    }

    this.sig = ackSig
    this.signed_state = canonical
    //state is not saved in db just yet, ensure to save later!
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

Delta.prototype.getState = async function() {
  var left = Buffer.compare(this.myId, this.partnerId) == -1

  // builds current canonical state.
  // Note that "new" settle and fail are still present in state

  var state = [
    methodMap('disputeWith'),
    [
      left ? this.myId : this.partnerId,
      left ? this.partnerId : this.myId,
      this.nonce,
      this.offdelta,
      this.asset
    ],
    // 2 is inwards for left, 3 for right
    [],
    []
  ]
  ;(await this.getPayments({
    where: {
      [Op.or]: [
        {type: 'add', status: 'sent'},
        {type: 'add', status: 'acked'},
        {type: 'settle', status: 'new'},
        {type: 'fail', status: 'new'}
      ]
    },
    //limit: 1000,
    // explicit order because of postgres https://github.com/sequelize/sequelize/issues/9289
    order: [['id', 'ASC']]
  })).map((t) => {
    // this == works like XOR. [2] gets all inwards for left and [3] for right
    state[t.is_inward == left ? 2 : 3].push(t.toLock())
  })

  return state
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

Block = privSequelize.define('block', {
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
})
