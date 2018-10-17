module.exports = async (args) => {
  let [pubkey, sig, body] = args
  let limits = r(body)

  let ch = await me.getChannel(pubkey, readInt(limits[1]))

  if (readInt(limits[0]) == methodMap('requestInsurance')) {
    ch.d.they_requested_insurance = true
    l('Queued for insurance')
    return
  }

  if (
    !ec.verify(body, sig, pubkey) ||
    readInt(limits[0]) != methodMap('setLimits')
  ) {
    l('Invalid message')
    return false
  }

  ch.d.they_soft_limit = readInt(limits[2])
  ch.d.they_hard_limit = readInt(limits[3])

  me.send(ch.d.partnerId, 'textMessage', r(['Updated limits ' + ch.d.asset]))

  l('Received updated limits in asset ' + ch.d.asset)
  //if (argv.syncdb) ch.d.save()
}
