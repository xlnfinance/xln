
// Off-Chain database - local and private stuff

if (!fs.existsSync('private')) fs.mkdirSync('private')
  
var base_db = {
  dialect: 'sqlite',
  // dialectModulePath: 'sqlite3',
  storage: 'private/db.sqlite',
  define: {timestamps: false},
  operatorsAliases: false,
  logging: false
}

privSequelize = new Sequelize('', '', 'password', base_db)

Block = privSequelize.define('block', {
  block: Sequelize.CHAR.BINARY,
  hash: Sequelize.CHAR(32).BINARY,
  prev_hash: Sequelize.CHAR(32).BINARY,
  meta: Sequelize.TEXT,
  
  total_tx: Sequelize.INTEGER
})


// stores all payment channels, offdelta and last signatures
// TODO: seamlessly cloud backup it. If signatures are lost, money is lost

// we name our things "value", and counterparty's "they_value" 
Delta = privSequelize.define('delta', {
  // between who and who
  myId: Sequelize.CHAR(32).BINARY,
  partnerId: Sequelize.CHAR(32).BINARY,

  // higher nonce is valid
  nonce: Sequelize.INTEGER,
  status: Sequelize.TEXT,

  instant_until: Sequelize.INTEGER,

  // TODO: clone from Insurance table to Delta to avoid double querying both dbs
  insurance: Sequelize.INTEGER,
  ondelta: Sequelize.INTEGER,


  offdelta: Sequelize.INTEGER,

  soft_limit: Sequelize.INTEGER,
  hard_limit: Sequelize.INTEGER, // we trust up to

  they_soft_limit: Sequelize.INTEGER,
  they_hard_limit: Sequelize.INTEGER, // they trust us


  last_online: Sequelize.DATE,
  withdrawal_requested_at: Sequelize.DATE,

  they_input_amount: Sequelize.INTEGER,

  input_amount: Sequelize.INTEGER,
  input_sig: Sequelize.TEXT, // we store a withdrawal sig to use in next rebalance

  hashlocks: Sequelize.TEXT,

  sig: Sequelize.TEXT,
  signed_state: Sequelize.TEXT,

  // testnet: cheaty transaction
  most_profitable: Sequelize.TEXT

})

Transition = privSequelize.define('transition', {

  // await, sent, ready
  status: Sequelize.TEXT,

  // who is recipient
  mediate_to: Sequelize.TEXT,

  // string needed to decrypt
  unlocker: Sequelize.TEXT,

  // a change in offdelta 
  offdelta: Sequelize.INTEGER,
  hash: Sequelize.TEXT,
  // best by block
  exp: Sequelize.INTEGER
})

Delta.hasMany(Transition)
Transition.belongsTo(Delta)





Delta.prototype.getState = async function () {
  var compared = Buffer.compare(this.myId, this.partnerId)

  var state = [
    methodMap('dispute'),
    compared==-1?this.myId:this.partnerId,
    compared==-1?this.partnerId:this.myId,
    this.nonce,
    this.offdelta,
    (await this.getTransitions({where: {status: 'hashlock'}})).map(
      t=>[t.offdelta, t.hash, t.exp]
    )
  ]

  return state
}






Delta.prototype.getDispute = async function() {
  // post last sig if any
  var partner = await User.idOrKey(this.partnerId)
  return this.sig ? [partner.id, this.sig, this.nonce, this.offdelta, []] : [partner.id]
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
    await me.broadcast('rebalance', r([ [(await this.getDispute())], [],[] ]))    
  }

  await this.save()

}

History = privSequelize.define('history', {
  leftId: Sequelize.CHAR(32).BINARY,
  rightId: Sequelize.CHAR(32).BINARY,

  date: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
  delta: Sequelize.INTEGER,

  amount: Sequelize.INTEGER,
  balance: Sequelize.INTEGER,
  desc: Sequelize.TEXT

})

Purchase = privSequelize.define('purchase', {
  myId: Sequelize.CHAR(32).BINARY,
  partnerId: Sequelize.INTEGER,

  delta: Sequelize.INTEGER,

  amount: Sequelize.INTEGER,
  balance: Sequelize.INTEGER,
  desc: Sequelize.TEXT,

  date: { type: Sequelize.DATE, defaultValue: Sequelize.NOW }

})

Event = privSequelize.define('event', {
  data: Sequelize.CHAR.BINARY,
  kindof: Sequelize.STRING,
  p1: Sequelize.STRING
})