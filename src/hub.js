module.exports = async function () {
  var hubId = 1

  var deltas = await Delta.findAll({where: {hubId: hubId}})

  var ins = []
  var outs = []

  var channels = []

  me.record = await me.byKey()

  var solvency = me.record.balance

  for (var d of deltas) {
    var ch = await me.channel(d.userId)

    solvency -= ch.rdelta

    channels.push(ch)

    if (ch.rdelta <= -K.risk) {
      ins.push(d.sig)
    } else if (ch.rdelta >= K.risk) {
      outs.push([d.userId, hubId, ch.rdelta])
    } else {
      // l("This is low delta ", ch)
    }
  }

  return {
    channels: channels,
    solvency: solvency,
    ins: ins,
    outs: outs
  }
}
