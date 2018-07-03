module.exports = async (p) => {
  // sets credit limits to a hub
  let result = {}
  let m = K.hubs.find((m) => m.id == p.partner)

  if (!m) return result

  let ch = await me.getChannel(m.pubkey, p.asset)
  ch.d.soft_limit = parseInt(p.limits[0]) * 100
  ch.d.hard_limit = parseInt(p.limits[1]) * 100
  await ch.d.save()

  me.send(
    m,
    'setLimits',
    me.envelope(map('setLimits'), ch.d.asset, ch.d.soft_limit, ch.d.hard_limit)
  )

  result.confirm = 'Credit limits updated'
  return result
}
