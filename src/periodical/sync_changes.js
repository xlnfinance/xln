// cache layer stores most commonly edited records:
// channels, payments, users and insurances
// also K.json is stored
module.exports = async (opts = {}) => {
  return await section('syncChanges', async () => {
    var all = []

    if (K) {
      let K_dump = stringify(K)

      // rewrite only if changed
      if (K_dump != cache.last_K_dump) {
        fs.writeFileSync(
          require('path').resolve(
            __dirname,
            '../../' + datadir + '/onchain/k.json'
          ),
          K_dump,
          function(err) {
            if (err) return console.log(err)
          }
        )
        cache.last_K_dump = K_dump
      }
    }

    // saving all deltas and corresponding payment objects to db
    // it only saves changed() records, so call save() on everything

    for (var key in cache.users) {
      var u = cache.users[key]

      if (u.id && u.changed()) {
        all.push(u.save())
      }
    }

    if (opts.flush == 'users') cache.users = {}

    for (var key in cache.ins) {
      var u = cache.ins[key]

      if (u.id && u.changed()) {
        all.push(u.save())
      }
    }

    var new_ch = {}

    for (let key in cache.ch) {
      let ch = cache.ch[key]

      await section(['use', ch.d.partnerId], async () => {
        // sync all Channel, Subchannel, Payments

        //return false
        let all_payments = []

        //l('Saving subch: ', ch.d.subchannels.length)
        for (let subch of ch.d.subchannels) {
          //if (ch.d.subchannels[i].changed()) {
          //subch.channelId = ch.d.id

          //l('Saving subch... ', subch)
          all_payments.push(subch.save())
          //}
        }

        for (let i = 0; i < ch.payments.length; i++) {
          let t = ch.payments[i]
          //t.channelId = ch.d.id

          if (t.changed()) {
            all_payments.push(t.save())
          }

          // delacked payments are of no interest anymore
          if (t.type + t.status == 'delack') {
            //delete ch.payments[i]
            ch.payments.splice(i, 1)
          }
        }

        if (ch.d.changed()) {
          all_payments.push(ch.d.save())
        }

        let evict = ch.last_used < ts() - K.cache_timeout

        await Promise.all(all_payments)

        // the channel is only evicted after it is properly saved in db
        if (evict) {
          delete cache.ch[key]
          //promise = promise.then(() => {
          //l('Evict: ' + trim(ch.d.partnerId))
          //})
        }

        //all.push(promise)
      })
    }

    //cache.ch = new_ch

    if (all.length > 0) {
      //l(`syncChanges done: ${all.length}`)
    }

    return await Promise.all(all)
  })
}
