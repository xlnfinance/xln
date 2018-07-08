// Onchain database - every full node has exact same copy
let base_db = {
  dialect: 'sqlite',
  // dialectModulePath: 'sqlite3',
  storage: datadir + '/onchain/db.sqlite',
  define: {timestamps: false},
  operatorsAliases: false,

  logging: (str, time) => {
    if (parseInt(time) > 300) {
      loff(time + ' (on) ' + str)
    }
  },

  benchmark: true
}

sequelize = new Sequelize('', '', 'password', base_db)
l('Reading db ', base_db.storage)

// >>> Schemes

User = sequelize.define(
  'user',
  {
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

Insurance = sequelize.define(
  'insurance',
  {
    leftId: Sequelize.INTEGER,
    rightId: Sequelize.INTEGER,

    nonce: {type: Sequelize.INTEGER, defaultValue: 0}, // for instant withdrawals, increase one by one
    asset: {type: Sequelize.INTEGER, defaultValue: 1},

    insurance: {type: Sequelize.BIGINT, defaultValue: 0}, // insurance
    ondelta: {type: Sequelize.BIGINT, defaultValue: 0}, // what hub already insuranceized

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

Proposal = sequelize.define('proposal', {
  desc: Sequelize.TEXT,
  code: Sequelize.TEXT,
  patch: Sequelize.TEXT,

  delayed: Sequelize.INTEGER, //cron

  kindof: Sequelize.STRING
})

Vote = sequelize.define('vote', {
  rationale: Sequelize.TEXT,
  approval: Sequelize.BOOLEAN // approval or denial
})

Debt = sequelize.define('debt', {
  asset: Sequelize.INTEGER,
  amount_left: Sequelize.INTEGER,
  oweTo: Sequelize.INTEGER
})

Order = sequelize.define('order', {
  amount: Sequelize.INTEGER,
  rate: Sequelize.FLOAT
})

// Hashlocks is like an evidence guarantee: if you have the secret before exp you unlock the action
// Primarily used in atomic swaps and mediated transfers. Based on Sprites concept
// They are are stored for a few days and unlock a specific action
Hashlock = sequelize.define(
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

Asset = sequelize.define('asset', {
  ticker: Sequelize.TEXT,
  name: Sequelize.TEXT,
  desc: Sequelize.TEXT,

  division: Sequelize.INTEGER, // division point for min unit, 0 for yen 2 for dollar

  issuable: Sequelize.BOOLEAN,
  issuerId: Sequelize.INTEGER,
  total_supply: Sequelize.INTEGER
})

// >>> Relations

Debt.belongsTo(User)
User.hasMany(Debt)

User.hasMany(Order)
Order.belongsTo(User)

Asset.hasMany(Order)
Asset.hasMany(Order, {as: 'buyAsset', foreign_key: 'buyAsset'})
Order.belongsTo(Asset)
Order.belongsTo(Asset, {as: 'buyAsset'})

Proposal.belongsTo(User)
Proposal.belongsToMany(User, {through: Vote, as: 'voters'})

// >>> Model methods
// some buffers are full pubkeys, some can be id (number/buffer) to save bytes
User.idOrKey = async function(id) {
  if (typeof id != 'number' && id.length != 32) {
    id = readInt(id)
  }

  var u = false

  // if integer, iterate over obj, if pubkey return by key
  if (typeof id == 'number') {
    for (var key in cache.users) {
      if (cache.users[key].id == id) {
        u = cache.users[key]
        break
      }
    }
  } else {
    u = cache.users[id]
  }

  if (u) return u

  if (typeof id == 'number') {
    u = await User.findById(id)
  } else {
    // buffer
    u = (await User.findOrBuild({
      where: {pubkey: id}
    }))[0]
  }

  if (u) {
    cache.users[u.pubkey] = u
  }

  return u
}

User.prototype.asset = function(asset, diff) {
  // native assets have dedicated column
  if (this.hasOwnProperty('balance' + asset)) {
    if (diff) {
      return (this['balance' + asset] += diff)
    } else {
      return this['balance' + asset]
    }
  } else {
    // read and write on the fly
    let bals = JSON.parse(this.balances || '{}')
    if (diff) {
      if (!bals[asset]) {
        bals[asset] = 0
      }
      bals[asset] += diff
      this.balances = stringify(bals)
      return bals[asset]
    } else {
      // 0 by default
      return bals[asset] ? bals[asset] : 0
    }
  }
}

User.prototype.payDebts = async function(asset, parsed_tx) {
  if (!this.has_debts) return false

  let debts = await this.getDebts({where: {asset: asset}})

  for (let d of debts) {
    var u = await User.idOrKey(d.oweTo)

    if (d.amount_left <= this.asset(asset)) {
      this.asset(asset, -d.amount_left)
      u.asset(asset, d.amount_left)

      parsed_tx.events.push(['enforceDebt', d.amount_left, u.id])

      //await u.save()
      await d.destroy() // the debt was paid in full
    } else {
      let full = this.asset(asset)
      d.amount_left -= full
      u.asset(asset, full)
      this.asset(asset, -full) // this user's balance is 0 now!

      parsed_tx.events.push(['enforceDebt', full, u.id])

      //await u.save()
      await d.save()

      break
    }
  }

  // no debts left (including other assets)?
  if ((await this.countDebts()) == 0) {
    this.has_debts = false
  }
}

Proposal.prototype.execute = async function() {
  if (this.code) {
    await eval(`(async function() { ${this.code} })()`)
  }

  if (this.patch.length > 0) {
    me.request_reload = true
    try {
      let pr = require('child_process').exec(
        'patch -p1',
        (error, stdout, stderr) => {
          console.log(error, stdout, stderr)
        }
      )
      pr.stdin.write(this.patch)
      pr.stdin.end()
    } catch (e) {
      l(e)
    }
  }
}

// you cannot really reason about who owns what by looking at onchain db only (w/o offdelta)
// but the hubs with higher sum(insurance) locked around them are more trustworthy
// and users probably own most part of insurances around them
Insurance.sumForUser = async function(id, asset = 1) {
  var sum = await Insurance.sum('insurance', {
    where: {
      [Op.or]: [{leftId: id}, {rightId: id}],
      asset: asset
    }
  })
  return sum > 0 ? sum : 0
}

// get an insurance between two user objects
Insurance.btw = async function(user1, user2, asset = 1) {
  if (user1.pubkey.length != 32 || user2.pubkey.length != 32) {
    return false
  }

  var compared = Buffer.compare(user1.pubkey, user2.pubkey)
  if (compared == 0) return false

  var wh = {
    leftId: compared == -1 ? user1.id : user2.id,
    rightId: compared == -1 ? user2.id : user1.id,
    asset: asset
  }
  var str = stringify([wh.leftId, wh.rightId, wh.asset])

  var ins = cache.ins[str]
  if (ins) return ins

  ins = (await Insurance.findOrBuild({
    where: wh
  }))[0]

  cache.ins[str] = ins
  return ins
}

Insurance.prototype.resolve = async function() {
  if (this.dispute_hashlocks) {
    // are there any hashlocks attached to this dispute? Check for unlocked ones
    var [left_inwards, right_inwards] = r(this.dispute_hashlocks)

    // returns total amount of all revealed (on time) preimages
    var find_revealed = async (locks) => {
      var final = 0
      for (var lock of locks) {
        var hl = await Hashlock.findOne({
          where: {
            hash: lock[1]
          }
        })

        if (hl) {
          if (hl.revealed_at <= readInt(lock[2])) {
            final += readInt(lock[0])
          } else {
            l('Revealed too late ', lock)
          }
        } else {
          l('Failed to unlock: ', lock)
        }
      }
      return final
    }

    this.dispute_offdelta += await find_revealed(left_inwards)
    this.dispute_offdelta -= await find_revealed(right_inwards)
  }

  var resolved = resolveChannel(
    this.insurance,
    this.ondelta + this.dispute_offdelta,
    true
  )

  var left = await User.idOrKey(this.leftId)
  var right = await User.idOrKey(this.rightId)

  // splitting insurance between users
  left.asset(this.asset, resolved.insured)
  right.asset(this.asset, resolved.they_insured)

  // anybody owes to anyone?
  if (resolved.they_uninsured > 0 || resolved.uninsured > 0) {
    var d = await Debt.create({
      asset: this.asset,
      userId: resolved.they_uninsured > 0 ? left.id : right.id,
      oweTo: resolved.they_uninsured > 0 ? right.id : left.id,
      amount_left:
        resolved.they_uninsured > 0
          ? resolved.they_uninsured
          : resolved.uninsured
    })

    // optimization flag
    if (resolved.they_uninsured > 0) {
      left.has_debts = true
    } else {
      right.has_debts = true
    }
  }

  /*
  await left.save()
  await right.save()
  */

  this.insurance = 0
  this.ondelta = -this.dispute_offdelta

  this.dispute_delayed = null
  this.dispute_hashlocks = null
  this.dispute_left = null
  //this.dispute_nonce = null
  this.dispute_offdelta = null

  await this.save()

  var withUs = me.is_me(left.pubkey)
    ? right
    : me.is_me(right.pubkey)
      ? left
      : false

  // are we in this dispute? Unfreeze the channel
  if (withUs) {
    var ch = await me.getChannel(withUs.pubkey, this.asset)

    // reset all credit limits - the relationship starts "from scratch"
    ch.d.soft_limit = 0
    ch.d.hard_limit = 0
    ch.d.they_soft_limit = 0
    ch.d.they_hard_limit = 0

    ch.d.status = 'master'
    ch.d.ack_requested_at = null
    //await ch.d.save()
  }

  return resolved
}

Order.prototype.buyAmount = async function() {
  if (this.assetId > this.buyAssetId) {
    return this.amount * this.rate
  } else {
    return this.amount / this.rate
  }
}
