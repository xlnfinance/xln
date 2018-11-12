module.exports = async (args) => {
  let [pubkey, sig, body] = args
  let limits = r(body)

  let asset = readInt(limits[1])

  let ch = await Channel.get(pubkey)
  let subch = ch.d.subchannels.by('asset', asset)

  if (readInt(limits[0]) == methodMap('requestInsurance')) {
    subch.they_requested_insurance = true
    l('Queued for insurance')
    me.textMessage(ch.d.partnerId, 'Added to rebalance queue')
    return
  }

  if (
    !ec.verify(body, sig, pubkey) ||
    readInt(limits[0]) != methodMap('setLimits')
  ) {
    l('Invalid message')
    return false
  }

  subch.they_soft_limit = readInt(limits[2])
  subch.they_hard_limit = readInt(limits[3])

  me.textMessage(ch.d.partnerId, 'Updated credit limits')

  l('Received updated limits in asset ' + ch.d.asset)
  //if (argv.syncdb) ch.d.save()
}
