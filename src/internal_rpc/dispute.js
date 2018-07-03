module.exports = async (p) => {
  var ch = await me.getChannel(
    K.hubs.find((m) => m.id == p.partner).pubkey,
    p.asset
  )
  await ch.d.startDispute(p.profitable)

  let result = {confirm: 'Started a Dispute'}
  return result
}
