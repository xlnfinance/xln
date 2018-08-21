const Router = require('../router')
// short helper to create a Payment on some delta and flush the channel right after it
module.exports = async (opts) => {
  section('pay', async () => {
    let secret = crypto.randomBytes(32)
    let hash = sha3(secret)

    //l('paying ', opts.destination.length, toHex(opts.destination))

    // todo not generate secret and exp here and do it during 'add'ing
    if (!opts.address) {
      l('Error: No address ', opts)
      return false
    }

    let addr = parseAddress(opts.address)

    if (!addr) {
      l('Invalid address')
      return
    }

    if (addr.address == me.getAddress()) {
      react({alert: `Cannot pay to yourself`}, false)
      return
    }

    //l('Paying to ', addr)

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
    if (!Number.isInteger(amount)) return

    if (!opts.chosenRoute) {
      // by default choose the cheapest one
      opts.chosenRoute = await Router.bestRoutes(addr.hubs, {
        amount: amount,
        asset: opts.asset
      })[0]
    }

    if (!opts.chosenRoute) {
      l('No such chosen route exists')
      return false
    }

    // 1. encrypt msg for destination that has final amount/asset etc and empty envelope
    let onion = encrypt_box_json(
      {
        amount: amount, // final amount
        asset: opts.asset,

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
    l('Lets encrypt for ', reversed)
    for (let hop of reversed) {
      let hub = K.hubs.find((h) => h.id == hop)

      amount = beforeFee(amount, hub)

      onion = encrypt_box_json(
        {
          asset: opts.asset,
          amount: amount,
          nextHop: nextHop,

          unlocker: onion
        },
        fromHex(hub.box_pubkey)
      )

      nextHop = hub.pubkey
    }

    // 3. now nextHop is equal our first hop, and amount includes all fees
    let ch = await me.getChannel(nextHop, opts.asset)

    if (!ch) return

    if (amount > ch.payable) {
      react({alert: `Not enough funds ${ch.payable}`}, false)
    } else if (amount > K.max_amount) {
      react({alert: `Maximum payment is $${commy(K.max_amount)}`}, false)
    } else if (amount < K.min_amount) {
      react({alert: `Minimum payment is $${commy(K.min_amount)}`}, false)
    } else {
      let outward = Payment.build({
        deltumId: ch.d.id,
        type: opts.addrisk ? 'addrisk' : 'add',
        lazy_until: opts.lazy ? +new Date() + 30000 : null,

        status: 'new',
        is_inward: false,
        asset: opts.asset,

        amount: amount,
        hash: bin(hash),
        exp: K.usable_blocks + K.hashlock_exp,

        unlocker: onion,
        destination_address: addr.address,
        invoice: opts.invoice
      })

      if (argv.syncdb) {
        await outward.save()
      }

      ch.payments.push(outward)
    }

    react({}, false)
    me.flushChannel(ch.d.partnerId, opts.asset, true)

    if (argv.syncdb) {
      //all.push(ch.d.save())
      await syncdb() //Promise.all(all)
    }
  })
}
