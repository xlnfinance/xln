module.exports = async (p) => {
  // sets credit limits to a hub
  let result = {}
  let m = K.hubs.find((m) => m.id == p.partner)

  if (!m) return result

  let ch = await me.getChannel(m.pubkey, p.asset)

  if (p.limits) {
    ch.d.hard_limit = parseInt(p.limits[0]) * 100
    ch.d.soft_limit = parseInt(p.limits[1]) * 100
  }

  ch.d.requested_insurance = p.request_insurance == 1
  await ch.d.save()

  me.send(
    m,
    'setLimits',
    me.envelope(
      methodMap('setLimits'),
      ch.d.asset,
      ch.d.soft_limit,
      ch.d.hard_limit,
      p.request_insurance // 1 or undefined
    )
  )

  result.confirm = p.request_insurance
    ? 'Insurance requested! Please wait'
    : 'Credit limits updated'
  return result
}
