// Off-Chain database - local and private stuff

if (!fs.existsSync('private')) fs.mkdirSync('private')

var base_db = {
  dialect: 'sqlite',
  // dialectModulePath: 'sqlite3',
  storage: 'private/db.sqlite',
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
  asset: Sequelize.INTEGER,

  soft_limit: Sequelize.INTEGER,
  hard_limit: Sequelize.INTEGER, // we trust up to

  they_soft_limit: Sequelize.INTEGER,
  they_hard_limit: Sequelize.INTEGER, // they trust us

  last_online: Sequelize.DATE,
  withdrawal_requested_at: Sequelize.DATE,

  they_input_amount: Sequelize.INTEGER,

  input_amount: Sequelize.INTEGER,
  input_sig: Sequelize.TEXT, // we store a withdrawal sig to use in next rebalance

  sig: Sequelize.TEXT,
  signed_state: Sequelize.TEXT,

  // testnet: cheaty transaction
  most_profitable: Sequelize.TEXT,

  // 4th type of balance, equivalent traditional balance in a bank. For pocket change.
  // Exists for convenience like pulling payments when the user is offline.
  custodian_balance: {
    type: Sequelize.INTEGER,
    defaultValue: 0
  }
})

Payment = privSequelize.define('payment', {
  // await (to be sent outward) => sent => got secret => unlocking =>
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

Delta.prototype.getState = async function() {
  var left = Buffer.compare(this.myId, this.partnerId) == -1

  var inwards = (await this.getPayments({
    where: {
      status: {[Sequelize.Op.or]: ['added', 'settle', 'fail']},

      is_inward: true
    }
  })).map((t) => [t.amount, t.hash, t.exp])

  var outwards = (await this.getPayments({
    where: {status: 'added', is_inward: false}
  })).map((t) => [t.amount, t.hash, t.exp])

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
  return this.sig
    ? [partner.id, this.sig, this.nonce, this.offdelta, []]
    : [partner.id]
}

Delta.prototype.startDispute = async function(profitable) {
  if (profitable) {
    if (this.most_profitable) {
      var profitable = r(this.most_profitable)
      this.offdelta = readInt(profitable[0])
      this.nonce = readInt(profitable[1])
      this.sig = profitable[2]
    } else {
      this.sig = null
    }
  }

  if (me.my_hub) {
    this.status = 'cheat_dispute'
    // we don't broadcast dispute right away and wait until periodic rebalance
  } else {
    this.status = 'disputed'
    await me.broadcast('rebalance', r([[await this.getDispute()], [], []]))
  }

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

/*
History = privSequelize.define('history', {
  leftId: Sequelize.CHAR(32).BINARY,
  rightId: Sequelize.CHAR(32).BINARY,

  date: {type: Sequelize.DATE, defaultValue: Sequelize.NOW},
  delta: Sequelize.INTEGER,

  amount: Sequelize.INTEGER,
  balance: Sequelize.INTEGER,
  desc: Sequelize.TEXT
})
*/
