// This method gets Insurance from onchain db, Delta from offchain db
// then derives a ton of info about current channel: (un)insured balances

// TODO: periodically clone Insurance to Delta db to only deal with one db having all data
module.exports = async (pubkey, asset, delta = false) => {
  // this critical section protects from simultaneous getChannel and doublesaved db records
  return await q(['get', pubkey, asset], async () => {
    let ch

    if (typeof pubkey == 'string') pubkey = fromHex(pubkey)

    var key = stringify([pubkey, asset])
    if (cache.ch[key]) {
      ch = cache.ch[key]
      refresh(ch)
      return ch
    }

    l('Loading channel from db: ', key)

    if (!me.pubkey) {
      return false
    }

    // accepts pubkey only
    let compared = Buffer.compare(me.pubkey, pubkey)
    if (compared == 0) {
      l('Channel to self?')
      return false
    }
    
    if (!(asset > 0)) {
      l('Invalid asset id', asset)
      asset = 1
    }

    ch = {
      left: compared == -1,

      rollback: [0, 0], // used in merge situations

      last_used: ts(), // for eviction from memory

      online:
        me.users[pubkey] &&
        (me.users[pubkey].readyState == 1 ||
          (me.users[pubkey].instance &&
            me.users[pubkey].instance.readyState == 1))
    }

    let my_hub = (p) => K.hubs.find((m) => m.pubkey == toHex(p))
    ch.hub = my_hub(pubkey) || {handle: toHex(pubkey).substr(0, 10)}

    if (delta) {
      ch.d = delta
    } else {
      let created = await Delta.findOrCreate({
        where: {
          myId: me.pubkey,
          partnerId: pubkey,
          asset: asset
        },
        defaults: {
          nonce: 0,
          status: 'master',
          offdelta: 0,

          input_amount: 0,
          they_input_amount: 0,

          soft_limit: my_hub(pubkey) ? K.risk : 0,
          hard_limit: my_hub(pubkey) ? K.hard_limit : 0,

          they_soft_limit: my_hub(me.pubkey) ? K.risk : 0,
          they_hard_limit: my_hub(me.pubkey) ? K.hard_limit : 0
        }
      })

      ch.d = created[0]
      if (created[1]) {
        loff(`Creating channel ${trim(pubkey)} - ${asset}: ${ch.d.id}`)
      }
    }

    let user = await User.idOrKey(pubkey)
    
    // default ins
    ch.ins = Insurance.build({
      insurance: 0,
      ondelta: 0,
      nonce: 0
    })

    if (user && user.id) {
      ch.partner = user.id
      if (me.record) {
        ch.ins = await Insurance.btw(me.record, user, asset)
      }
    }

    ch.payments = await ch.d.getPayments({
      where: {
        // delack is archive
        [Op.or]: [{type: {[Op.ne]: 'del'}}, {status: {[Op.ne]: 'ack'}}]
      },
      //limit: 1000,
      // explicit order because of postgres https://github.com/sequelize/sequelize/issues/9289
      order: [['id', 'ASC']]
    })

    refresh(ch)

    cache.ch[key] = ch
    //l('Saved in cache ', key)
    return ch
  })
}
