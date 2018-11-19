const Router = require('../router')
// short helper to create a Payment on some delta and flush the channel right after it
module.exports = async (opts) => {
  return await section('pay', async () => {
    let secret = crypto.randomBytes(32)
    let hash = sha3(secret)
    let asset = parseInt(opts.asset)

    //l('paying ', opts.destination.length, toHex(opts.destination))

    if (!opts.address) {
      l('Error: No address ', opts)
      return 'Error: No address'
    }

    let addr = parseAddress(opts.address)

    if (!addr) {
      l('Invalid address')
      return 'Invalid address'
    }

    /* for offchain rebalancing 

    if (addr.address == me.getAddress()) {
      react({alert: `Cannot pay to yourself`})
      return
    }
    */

    // use user supplied private message, otherwise generate random tag
    // invoice inside the address takes priority
    if (addr.invoice || opts.invoice) {
      opts.invoice = concat(
        Buffer.from([1]),
        bin(addr.invoice ? addr.invoice : opts.invoice)
      )
    } else {
      opts.invoice = concat(Buffer.from([2]), crypto.randomBytes(16))
    }

    let amount = parseInt(opts.amount)

    // NaN
    if (!Number.isInteger(amount)) return 'NaN'

    if (!opts.chosenRoute) {
      if (me.my_hub && addr.hubs.includes(me.my_hub.id)) {
        // just pay direct
        opts.chosenRoute = []
      } else {
        // by default choose the cheapest one
        let best = await Router.bestRoutes(opts.address, {
          amount: amount,
          asset: asset
        })
        if (!best[0]) {
          l('No route found:', best, addr.hubs)
          return 'No route found:'
        } else {
          // first is the cheapest
          opts.chosenRoute = best[0][1]
        }
      }
    }

    // 1. encrypt msg for destination that has final amount/asset etc and empty envelope
    let onion = encrypt_box_json(
      {
        amount: amount, // final amount
        asset: asset,

        // buffers are in hex for JSON
        secret: toHex(secret),
        invoice: toHex(opts.invoice),

        ts: ts(),
        source_address: opts.provideSource ? me.getAddress() : null
      },
      addr.box_pubkey
    )

    let nextHop = addr.pubkey

    // 2. encrypt msg for each hop in reverse order
    let reversed = opts.chosenRoute.reverse()
    for (let hop of reversed) {
      let hub = K.hubs.find((h) => h.id == hop)

      amount = beforeFee(amount, hub)

      onion = encrypt_box_json(
        {
          asset: asset,
          amount: amount,
          nextHop: nextHop,

          unlocker: onion
        },
        fromHex(hub.box_pubkey)
      )

      nextHop = hub.pubkey
    }

    // 3. now nextHop is equal our first hop, and amount includes all fees
    let ch = await Channel.get(nextHop)
    if (!ch) {
      l('No channel to ', nextHop, asset)
      return 'No channel to '
    }

    let subch = ch.d.subchannels.by('asset', asset)
    let payable = ch.derived[asset].payable

    // 4. do we have enough payable for this hop?
    if (amount > payable) {
      if (me.my_hub) {
        // ask to increase credit
        me.textMessage(
          ch.d.partnerId,
          `Cannot send ${commy(amount)} when payable is ${commy(
            payable
          )}, extend credit`
        )
      }
      react({alert: `Not enough funds ${payable}`})

      return
    } else if (amount > K.max_amount) {
      return react({alert: `Maximum payment is $${commy(K.max_amount)}`})
    } else if (amount < K.min_amount) {
      return react({alert: `Minimum payment is $${commy(K.min_amount)}`})
    }

    let outward = Payment.build({
      channelId: ch.d.id,

      type: opts.addrisk ? 'addrisk' : 'add',
      lazy_until: opts.lazy ? +new Date() + 30000 : null,

      status: 'new',
      is_inward: false,
      asset: asset,

      amount: amount,
      hash: bin(hash),

      unlocker: onion,
      destination_address: addr.address,
      invoice: opts.invoice
    })

    if (argv.syncdb) {
      await outward.save()
    }

    ch.payments.push(outward)

    //l('Paying to ', reversed)

    react({})
    me.flushChannel(ch.d.partnerId, true)

    return 'sent'

    if (argv.syncdb) {
      //all.push(ch.d.save())
      //await Periodical.syncChanges() //Promise.all(all)
    }
  })
}
