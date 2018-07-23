module.exports = async (args) => {
  if (me.CHEAT_dontwithdraw) {
    // if we dont give withdrawal or are offline for too long, the partner starts dispute
    return l('CHEAT_dontwithdraw')
  }

  // partner asked us for instant (mutual) withdrawal
  let [pubkey, sig, body] = args
  if (!ec.verify(body, sig, pubkey)) return false

  let [amount, asset] = r(body)
  amount = readInt(amount)
  asset = readInt(asset)

  let ch = await me.getChannel(pubkey, asset)

  if (ch.d.they_withdrawal_amount > 0) {
    l('Partner already has withdrawal from us')
    return false
  }

  if (amount == 0 || amount > ch.they_insured) {
    l(`Partner asks for ${amount} but owns ${ch.they_insured}`)
    return false
  }

  let withdrawal = r([
    methodMap('withdrawFrom'),
    ch.ins.leftId,
    ch.ins.rightId,
    ch.ins.nonce,
    amount,
    ch.d.asset
  ])

  ch.d.they_withdrawal_amount = amount
  if (argv.syncdb) ch.d.save()
  l('Gave withdrawal for ' + amount)

  me.send(
    pubkey,
    'withdrawFrom',
    r([me.pubkey, ec(withdrawal, me.id.secretKey), r([amount, asset])])
  )
}
