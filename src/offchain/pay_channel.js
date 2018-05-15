// short helper to create a Payment on some delta and flush the channel right after it
module.exports = async (opts) => {
  let secret = crypto.randomBytes(32)
  let hash = sha3(secret)

  let invoice = opts.invoice ? bin(opts.invoice) : crypto.randomBytes(32)

  let [box_pubkey, pubkey] = r(base58.decode(opts.destination.toString()))
  let amount = parseInt(opts.amount)

  var ch = await q([pubkey, opts.asset], async () => {
    let via = me.my_hub ? pubkey : fromHex(K.hubs[0].pubkey)
    let sent_amount = beforeFees(amount, [K.hubs[0].fee])
    let ch = await me.getChannel(via, opts.asset)

    if (ch.payable < 3000 && argv.monkey && !me.my_hub) {
      me.getCoins()
      await sleep(3000)
    }

    let unlocker_nonce = crypto.randomBytes(24)
    let unlocker_box = nacl.box(
      r([amount, secret, invoice]),
      unlocker_nonce,
      box_pubkey,
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
      await ch.d.createPayment({
        type: 'add',
        status: 'new',
        is_inward: false,
        asset: opts.asset,

        amount: sent_amount,
        hash: hash,
        exp: K.usable_blocks + K.hashlock_exp,

        unlocker: unlocker,
        destination: pubkey,
        invoice: invoice
      })
    }
    return ch
  })

  if (ch) {
    react({}, false)
    await me.flushChannel(ch.d.partnerId, opts.asset, true)
  }
}
