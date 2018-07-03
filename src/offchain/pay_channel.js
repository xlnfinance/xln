// short helper to create a Payment on some delta and flush the channel right after it
module.exports = async (opts) => {
  q('pay', async () => {
    let secret = crypto.randomBytes(32)
    let hash = sha3(secret)


    //l('paying ', opts.destination.length, toHex(opts.destination))

    // todo not generate secret and exp here and do it during 'add'ing
    if (!opts.address) {
      l('Error: No address ', opts)
      return false
    }

    var addr = parseAddress(opts.address)

    // invoice inside the address takes priority
    if (addr.invoice) {
      opts.invoice = addr.invoice
    }

    // use user supplied private message, otherwise generate random tag
    let invoice = opts.invoice ? concat(Buffer.from([1]), bin(opts.invoice)) : concat(Buffer.from([2]), crypto.randomBytes(16))

    let amount = parseInt(opts.amount)

    // if we are hub making a payment, don't add the fees on top
    if (me.my_hub) {
      var via = addr.pubkey
      var sent_amount = amount
    } else {
      var via = fromHex(K.hubs[0].pubkey)
      var sent_amount = beforeFees(amount, [K.hubs[0].fee])
    }

    let ch = await me.getChannel(via, opts.asset)

    let unlocker_nonce = crypto.randomBytes(24)

    // we are sender and passing to receiver the amount, preimage, invoice and our own address
    let unlocker_box = encrypt_box(
      r([amount, secret, invoice, bin(me.address)]),
      unlocker_nonce,
      addr.box_pubkey,
      me.box.secretKey
    )

    let unlocker = r([bin(unlocker_box), unlocker_nonce, bin(me.box.publicKey)])

    if (amount > ch.payable) {
      react({alert: `Not enough funds ${ch.payable}`}, false)
    } else if (amount > K.max_amount) {
      react({alert: `Maximum payment is $${commy(K.max_amount)}`}, false)
    } else if (amount < K.min_amount) {
      react({alert: `Minimum payment is $${commy(K.min_amount)}`}, false)
    } else {
      var outward = Payment.build({
        deltumId: ch.d.id,
        type: opts.addrisk ? 'addrisk' : 'add',
        lazy_until: opts.lazy ? +new Date() + 30000 : null,

        status: 'new',
        is_inward: false,
        asset: opts.asset,

        amount: sent_amount,
        hash: bin(hash),
        exp: K.usable_blocks + K.hashlock_exp,

        unlocker: unlocker,
        destination_address: opts.address,
        invoice: invoice
      })

      if (argv.syncdb) {
        await outward.save()
      }

      ch.payments.push(outward)
    }

    if (ch) {
      react({}, false)
      me.flushChannel(ch.d.partnerId, opts.asset, true)
    }
  })
}
