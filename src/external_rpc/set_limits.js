module.exports = async (args) => {
  let [pubkey, sig, body] = args
  let limits = r(body)

  let ch = await me.getChannel(pubkey, readInt(limits[1]))

  if (readInt(limits[0]) == methodMap('requestInsurance')) {
    ch.d.requested_insurance = true
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

  l('Received updated limits')
  //if (argv.syncdb) ch.d.save()
}
