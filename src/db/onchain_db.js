// Onchain database - every full node has exact same copy
var base_db = {
  dialect: 'sqlite',
  // dialectModulePath: 'sqlite3',
  storage: 'data/db.sqlite',
  define: {timestamps: false},
  operatorsAliases: false,
  logging: false
}

sequelize = new Sequelize('', '', 'password', base_db)

User = sequelize.define('user', {
  username: Sequelize.STRING,

  pubkey: Sequelize.CHAR(32).BINARY,
  nonce: Sequelize.INTEGER,
  balance: Sequelize.BIGINT // onchain balance: mostly to pay taxes
})

User.idOrKey = async function(id) {
  if (id.length == 32) {
    return (await User.findOrBuild({
      where: {pubkey: id},
      defaults: {
        nonce: 0,
        balance: 0
      }
    }))[0]
  } else {
    return await User.findById(readInt(id))
  }
}

User.prototype.payDebts = async function(parsed_tx) {
  var debts = await this.getDebts()

  for (var d of debts) {
    var u = await User.findById(d.oweTo)

    if (d.amount_left <= this.balance) {
      this.balance -= d.amount_left
      u.balance += d.amount_left

      parsed_tx.events.push(['enforceDebt', d.amount_left, u.id])

      await u.save()
      await d.destroy()
    } else {
      d.amount_left -= this.balance
      u.balance += this.balance
      this.balance = 0 // this user is broke now!

      parsed_tx.events.push(['enforceDebt', this.balance, u.id])

      await u.save()
      await d.save()
      break
    }
  }
}

Debt = sequelize.define('debt', {
  amount_left: Sequelize.INTEGER,
  oweTo: Sequelize.INTEGER
})

Debt.belongsTo(User)
User.hasMany(Debt)

Proposal = sequelize.define('proposal', {
  desc: Sequelize.TEXT,
  code: Sequelize.TEXT,
  patch: Sequelize.TEXT,

  delayed: Sequelize.INTEGER, //cron

  kindof: Sequelize.STRING
})

Proposal.prototype.execute = async function() {
  if (this.code) {
    await eval(`(async function() { ${this.code} })()`)
  }

  if (this.patch.length > 0) {
    me.request_reload = true
    try {
      var pr = require('child_process').exec(
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

Insurance = sequelize.define('insurance', {
  leftId: Sequelize.INTEGER,
  rightId: Sequelize.INTEGER,

  nonce: {type: Sequelize.INTEGER, defaultValue: 0}, // for instant withdrawals, increase one by one
  asset: {type: Sequelize.INTEGER, defaultValue: 0},

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
})

Insurance.prototype.resolve = async function() {
  if (this.dispute_hashlocks) {
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

        if (hl && hl.revealed_at <= readInt(lock[2])) {
          final += readInt(lock[0])
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

  l('Resolving with ', resolved)

  var left = await User.findById(this.leftId)
  var right = await User.findById(this.rightId)

  // splitting insurance between users
  left.balance += resolved.insured
  right.balance += resolved.they_insured

  // anybody owes to anyone?
  if (resolved.promised > 0 || resolved.they_promised > 0) {
    var d = await Debt.create({
      userId: resolved.promised > 0 ? left.id : right.id,
      oweTo: resolved.promised > 0 ? right.id : left.id,
      amount_left:
        resolved.promised > 0 ? resolved.promised : resolved.they_promised
    })
  }

  await left.save()
  await right.save()

  this.insurance = 0
  this.ondelta = 0

  this.dispute_delayed = null
  this.dispute_left = null
  //this.dispute_nonce = null
  this.dispute_offdelta = null

  await this.save()

  var withUs = me.pubkey.equals(left.pubkey)
    ? right
    : me.pubkey.equals(right.pubkey)
      ? left
      : false

  // are we in this dispute? Unfreeze the channel
  if (withUs) {
    var ch = await me.getChannel(withUs.pubkey)
    // reset all credit limits - the relationship starts "from scratch"
    ch.d.soft_limit = 0
    ch.d.hard_limit = 0
    ch.d.they_soft_limit = 0
    ch.d.they_hard_limit = 0

    ch.d.status = 'master'
    await ch.d.destroy()
  }
}

Vote = sequelize.define('vote', {
  rationale: Sequelize.TEXT,
  approval: Sequelize.BOOLEAN // approval or denial
})

Proposal.belongsTo(User)

// User.belongsToMany(User, {through: Insurance, as: 'left'})
// User.belongsToMany(User, {through: Insurance, as: 'right'})

Proposal.belongsToMany(User, {through: Vote, as: 'voters'})

// Hashlocks is like an evidence guarantee: if you have the secret before exp you unlock the action
// Primarily used in atomic swaps and mediated transfers. Based on Sprites concept
// They are are stored for a few days and unlock a specific action
Hashlock = sequelize.define('hashlock', {
  alg: Sequelize.INTEGER, // sha256, sha3?
  hash: Sequelize.TEXT,
  revealed_at: Sequelize.INTEGER
})

// Assets represent all numerical balances: currencies, tokens, shares, stocks.
// Anyone can create and issue their own asset (like ERC20, but not programmable)
Asset = sequelize.define('asset', {
  ticker: Sequelize.TEXT,
  desc: Sequelize.TEXT,

  issuerId: Sequelize.INTEGER,
  total_supply: Sequelize.INTEGER
})
