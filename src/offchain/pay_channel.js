module.exports = async (opts) => {
  var secret = crypto.randomBytes(32)
  var hash = sha3(secret)

  var invoice = opts.invoice ? bin(opts.invoice) : crypto.randomBytes(32)

  var [box_pubkey, pubkey] = r(base58.decode(opts.destination.toString()))
  var amount = parseInt(opts.amount)

  var via = me.my_hub ? pubkey : fromHex(K.hubs[0].pubkey)
  var sent_amount = beforeFees(amount, [K.hubs[0].fee])

  var unlocker_nonce = crypto.randomBytes(24)
  var unlocker_box = nacl.box(
    r([amount, secret, invoice]),
    unlocker_nonce,
    box_pubkey,
    me.box.secretKey
  )
  var unlocker = r([bin(unlocker_box), unlocker_nonce, bin(me.box.publicKey)])
  var ch = await me.getChannel(via)

  if (amount > ch.payable) {
    react({alert: `Not enough funds`})
  } else if (amount > K.max_amount) {
    react({alert: `Maximum payment is $${commy(K.max_amount)}`})
  } else if (amount < K.min_amount) {
    react({alert: `Minimum payment is $${commy(K.min_amount)}`})
  } else {
    await ch.d.save()

    await ch.d.createPayment({
      type: 'add',
      status: 'new',
      is_inward: false,

      amount: sent_amount,
      hash: hash,
      exp: K.usable_blocks + K.hashlock_exp,

      unlocker: unlocker,
      destination: pubkey,
      invoice: invoice
    })
    await me.flushChannel(ch)
  }
}
