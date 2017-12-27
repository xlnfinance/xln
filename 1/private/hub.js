module.exports = async function(dry_run = false){
  l("Matching senders and receivers...")

  var hubId = 1

  var deltas = await Delta.findAll({where: {hubId: hubId}})

  var ins = []
  var outs = []

  var channels = []

  for(var d of deltas){
    var ch = await me.channel(d.userId)

    if(ch.delta < -K.risk){
      ins.push(d.sig)
      channels.push(ch)

    }else if(ch.delta > K.risk){
      outs.push([d.userId, hubId, ch.delta])
      channels.push(ch)

    }else{
      //l("This is low delta ", ch)
    }
  }

  if(dry_run) return channels

  if(ins.length > 0 && outs.length > 0){
    l('Found matches ', ins, outs)
    await me.broadcast('settle', r([0, ins, outs]))
  }

}