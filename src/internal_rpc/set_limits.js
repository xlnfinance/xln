module.exports = async (p) => {
  // sets credit limits to a hub
  for (let action of p.chActions) {
    let ch = await me.getChannel(fromHex(action.partnerId), action.asset)

    if (!ch) return result

    // if limits are same, skip
    if (action.limits == [ch.d.hard_limit, ch.d.soft_limit]) {
      continue
    }

    ch.d.requested_insurance = action.request_insurance == 1
    await ch.d.save()

    l('set limits to ', ch.hub)

    me.send(
      ch.hub,
      'setLimits',
      me.envelope(
        methodMap('setLimits'),
        ch.d.asset,
        ch.d.soft_limit,
        ch.d.hard_limit,
        action.request_insurance // 1 or undefined
      )
    )
  }

  return {confirm: 'Updated limits with hubs'}
}
