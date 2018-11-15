// This method gets Insurance from onchain db, Channel from offchain db
// then derives a ton of info about current channel: (un)insured balances

class WrappedChannel {
  constructor() {}

  //toJSON(){}
}

// TODO: periodically clone Insurance to Channel db to only deal with one db having all data
module.exports = async (pubkey, delta = false) => {
  // this critical section protects from simultaneous getChannel and doublesaved db records
  return await section(['get', pubkey], async () => {
    if (!me.pubkey) {
      return false
    }

    let ch

    if (typeof pubkey == 'string') pubkey = fromHex(pubkey)

    var key = stringify([pubkey])
    if (cache.ch[key]) {
      ch = cache.ch[key]
      refresh(ch)
      return ch
    }

    //l('Loading channel from db: ', key)

    if (me.pubkey.equals(pubkey)) {
      l('Channel to self?')
      return false
    }

    /*      online:
        me.users[pubkey] &&
        (me.users[pubkey].readyState == 1 ||
          (me.users[pubkey].instance &&
            me.users[pubkey].instance.readyState == 1))

*/

    ch = {} //new WrappedChannel()
    ch.derived = {}

    ch.last_used = ts() // for eviction from memory

    if (delta) {
      ch.d = delta
    } else {
      /*
      let defaults = {}

      if (me.my_hub) {
        defaults.they_soft_limit = K.soft_limit
        defaults.they_hard_limit = K.hard_limit
      }
      if (my_hub(pubkey)) {
        defaults.soft_limit = K.soft_limit
        defaults.hard_limit = K.hard_limit
      }
      */

      ch.d = await Channel.findOne({
        where: {
          myId: me.pubkey,
          partnerId: pubkey
        },
        include: [Subchannel]
      })

      if (!ch.d) {
        loff(`Creating new channel ${trim(pubkey)}`)

        ch.d = await Channel.create(
          {
            myId: me.pubkey,
            partnerId: pubkey,
            subchannels: [
              {
                asset: 1
              },
              {
                asset: 2
              }
            ]
          },
          {include: [Subchannel]}
        )
        //l('New one', ch.d.subchannels)
      } else {
        //l('Found old channel ', ch.d.subchannels)
      }
    }

    let user = await getUserByIdOrKey(pubkey)

    if (user && user.id) {
      ch.partner = user.id
      if (me.record) {
        ch.ins = await getInsuranceBetween(me.record, user)
      }
    }

    ch.payments = await Payment.findAll({
      where: {
        channelId: ch.d.id,
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
