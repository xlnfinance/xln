module.exports = async (args) => {
  let [pubkey, sig, body] = args
  let limits = r(body)

  if (
    !ec.verify(body, sig, pubkey) ||
    readInt(limits[0]) != methodMap('setLimits')
  ) {
    l('Invalid message')
    return false
  }

  let ch = await me.getChannel(pubkey, readInt(limits[1]))

  ch.d.they_soft_limit = readInt(limits[2])
  ch.d.they_hard_limit = readInt(limits[3])
  ch.d.they_requested_insurance = readInt(limits[4]) == 1

  l('Received updated limits')
  //if (argv.syncdb) ch.d.save()
}
