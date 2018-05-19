// This method gets Insurance from onchain db, Delta from offchain db
// then derives a ton of info about current channel: (un)insured balances

// TODO: periodically clone Insurance to Delta db to only deal with one db having all data
module.exports = async (partner, asset) => {
  let ch

  var key = stringify([partner, asset])
  if (me.cached[key]) {
    ch = me.cached[key]
    refresh(ch)

    return ch
  }

  l('Loading channel from db: ', key)

  // accepts pubkey only
  let compared = Buffer.compare(me.pubkey, partner)
  if (compared == 0) {
    l('Channel to self?')
    return false
  }
  if (!(asset > 0)) {
    l('Invalid asset id', asset)
    asset = 1
    //return false
  }

  ch = {
    // default insurance
    insurance: 0,
    ondelta: 0,
    nonce: 0,
    left: compared == -1,

    rollback: [0, 0], // used in merge situations

    online:
      me.users[partner] &&
      (me.users[partner].readyState == 1 ||
        (me.users[partner].instance &&
          me.users[partner].instance.readyState == 1))
  }

  let my_hub = (p) => K.hubs.find((m) => m.pubkey == toHex(p))
  ch.hub = my_hub(partner) || {handle: toHex(partner).substr(0, 10)}

  // ch stands for Channel, d for Delta record, yes
  let created = await Delta.findOrCreate({
    where: {
      myId: me.pubkey,
      partnerId: partner,
      asset: asset
    },
    defaults: {
      nonce: 0,
      status: 'master',
      offdelta: 0,

      input_amount: 0,
      they_input_amount: 0,

      soft_limit: my_hub(partner) ? K.risk : 0,
      hard_limit: my_hub(partner) ? K.hard_limit : 0,

      they_soft_limit: my_hub(me.pubkey) ? K.risk : 0,
      they_hard_limit: my_hub(me.pubkey) ? K.hard_limit : 0
    }
  })

  ch.d = created[0]
  if (created[1]) {
    loff(`Creating channel ${trim(partner)} - ${asset}: ${ch.d.id}`)
  }

  //let user = await me.byKey(partner)
  if (true) {
    ch.partner = 1 //user.id
    if (me.record) {
      /*
      ch.ins = await Insurance.find({
        where: {
          leftId: ch.left ? me.record.id : user.id,
          rightId: ch.left ? user.id : me.record.id,
          asset: asset
        }
      })
      */
      ch.ins = Insurance.build({
        leftId: ch.left ? me.record.id : ch.partner,
        rightId: ch.left ? ch.partner : me.record.id,
        asset: asset,
        insurance: 100000000000,
        ondelta: 50000000000
      })
    }
  }

  if (ch.ins) {
    ch.insurance = ch.ins.insurance
    ch.ondelta = ch.ins.ondelta
    ch.nonce = ch.ins.nonce
  }

  ch.payments = await ch.d.getPayments({
    where: {
      // move to NOT
      [Op.or]: [
        {type: 'add', status: 'new'}, // pending
        {type: 'add', status: 'sent'}, // in state
        {type: 'add', status: 'acked'}, // in state
        {type: 'settle', status: 'new'}, // in state & pending
        {type: 'settle', status: 'sent'}, // sent
        {type: 'fail', status: 'new'}, // in state & pending
        {type: 'fail', status: 'sent'} // sent
      ]
    },
    //limit: 1000,
    // explicit order because of postgres https://github.com/sequelize/sequelize/issues/9289
    order: [['id', 'ASC']]
  })

  refresh(ch)

  me.cached[key] = ch
  l('Saved in cache ', key)
  return ch
}
