// Offchain database - local and private stuff

if (!fs.existsSync(datadir + '/offchain')) fs.mkdirSync(datadir + '/offchain')

var base_db = {
  dialect: 'sqlite',
  // dialectModulePath: 'sqlite3',
  storage: datadir + '/offchain/db.sqlite',
  define: {timestamps: true}, // we don't mind timestamps in offchain db
  operatorsAliases: false,
  logging: false
}

privSequelize = new Sequelize('', '', 'password', base_db)

// Encapsulates relationship with counterparty: offdelta and last signatures
// TODO: seamlessly cloud backup it. If signatures are lost, money is lost

// we name our things "value", and counterparty's "they_value"
Delta = privSequelize.define('delta', {
  // between who and who
  myId: Sequelize.CHAR(32).BINARY,
  partnerId: Sequelize.CHAR(32).BINARY,

  // higher nonce is valid
  nonce: Sequelize.INTEGER,
  status: Sequelize.TEXT,

  pending: Sequelize.TEXT,

  // TODO: clone from Insurance table to Delta to avoid double querying both dbs
  insurance: Sequelize.INTEGER,
  ondelta: Sequelize.INTEGER,

  offdelta: Sequelize.INTEGER,
  asset: {
    type: Sequelize.INTEGER,
    defaultValue: 0
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
  input_sig: Sequelize.TEXT, // we store a withdrawal sig to use in next rebalance

  sig: Sequelize.TEXT,
  signed_state: Sequelize.TEXT,

  // All the safety Byzantine checks start with cheat_
  CHEAT_profitable_state: Sequelize.TEXT,
  CHEAT_profitable_sig: Sequelize.TEXT,

  // 4th type of balance, equivalent traditional balance in a bank. For pocket change.
  // Exists for convenience like pulling payments when the user is offline.
  custodian_balance: {
    type: Sequelize.INTEGER,
    defaultValue: 0
  }
})

Payment = privSequelize.define('payment', {
  // add/settle/fail
  type: Sequelize.TEXT,
  // new>sent>acked
  status: Sequelize.TEXT,
  // no inward = sender, no outward = receiver, otherwise = mediator
  is_inward: Sequelize.BOOLEAN,

  // in mediated transfer, pull funds from previous inward
  // pull_from: Sequelize.INTEGER,
  //outward: Sequelize.TEXT,

  // outward = inward - fee
  amount: Sequelize.INTEGER,
  // hash is same for inward and outward
  hash: Sequelize.TEXT,
  // best by block
  exp: Sequelize.INTEGER,
  // asset type
  asset: Sequelize.INTEGER,

  // who is recipient
  destination: Sequelize.TEXT,
  // string to be decrypted by outward
  unlocker: Sequelize.TEXT,

  // user-specified or randomly generated private message
  invoice: Sequelize.TEXT,

  // secret that unlocks hash
  secret: Sequelize.TEXT
})

Delta.hasMany(Payment)
Payment.belongsTo(Delta)
//Delta.hasMany(Payment, {foreignKey: 'delta_id', sourceKey: 'id'})
//Payment.belongsTo(Delta, {foreignKey: 'delta_id', targetKey: 'id'})

Payment.prototype.toLock = function() {
  return [this.amount, this.hash, this.exp]
}

Payment.prototype.getInward = async function() {
  return await Payment.findOne({
    where: {hash: this.hash, is_inward: true, asset: this.asset},
    include: {all: true}
  })
}

Delta.prototype.saveState = async function(state, ackSig) {
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
    //l('Saving State Snapshot:')
    //logstate(state)
    await this.save()
    return true
  } else {
    return false
  }
}

Delta.prototype.requestFlush = async function() {
  if (!this.flush_requested_at) {
    //this.flush_requested_at = new Date()
    //await this.save()
    var ch = await me.getChannel(this.partnerId)
    await me.flushChannel(ch)
  }
}

Delta.prototype.getState = async function() {
  var left = Buffer.compare(this.myId, this.partnerId) == -1

  // builds current canonical state.
  // status="new" settle and fail are still present in state

  var inwards = (await this.getPayments({
    where: {
      [Op.or]: [
        {type: 'add', status: 'sent'},
        {type: 'add', status: 'acked'},
        {type: 'settle', status: 'new'},
        {type: 'fail', status: 'new'}
      ],
      is_inward: true
    }
  })).map((t) => t.toLock())

  var outwards = (await this.getPayments({
    where: {
      [Op.or]: [{type: 'add', status: 'sent'}, {type: 'add', status: 'acked'}],
      is_inward: false
    }
  })).map((t) => t.toLock())

  var state = [
    methodMap('dispute'),
    [
      left ? this.myId : this.partnerId,
      left ? this.partnerId : this.myId,
      this.nonce,
      this.offdelta,
      this.asset
    ],
    // 2 is inwards for left, 3 for right
    left ? inwards : outwards,
    left ? outwards : inwards
  ]

  return state
}

Delta.prototype.getDispute = async function() {
  // post last sig if any
  var partner = await User.idOrKey(this.partnerId)
  return this.sig ? [partner.id, this.sig, this.signed_state] : [partner.id]
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
  me.batch.push(['disputeWith', [d]])
  await this.save()
}

Block = privSequelize.define('block', {
  // sigs that authorize block
  precommits: Sequelize.CHAR.BINARY,
  // header with merkle roots in it
  header: Sequelize.CHAR.BINARY,
  // array of tx in block
  ordered_tx_body: Sequelize.CHAR.BINARY,

  hash: Sequelize.CHAR(32).BINARY,
  prev_hash: Sequelize.CHAR(32).BINARY,
  meta: Sequelize.TEXT,

  total_tx: Sequelize.INTEGER
})
