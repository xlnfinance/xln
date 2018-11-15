module.exports = async (args) => {
  //todo: ensure no conflicts happen if two parties withdraw from each other at the same time
  let [pubkey, sig, body] = args

  let [amount, asset] = r(body).map(readInt)

  let ch = await Channel.get(pubkey)
  let subch = ch.d.subchannels.by('asset', asset)

  let withdrawal = [
    methodMap('withdrawFrom'),
    ch.ins.leftId,
    ch.ins.rightId,
    ch.ins.withdrawal_nonce,
    amount,
    asset
  ]

  if (!ec.verify(r(withdrawal), sig, pubkey)) {
    l('Invalid withdrawal ', withdrawal)
    return false
  }

  l('Got withdrawal for ' + amount)
  subch.withdrawal_amount = amount
  subch.withdrawal_sig = sig

  if (me.withdrawalRequests[subch.id]) {
    me.withdrawalRequests[subch.id](ch)
  }

  if (argv.syncdb) ch.d.save()
}
