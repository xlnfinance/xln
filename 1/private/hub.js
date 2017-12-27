module.exports = async function(){
  var hubId = 1

  var deltas = await Delta.findAll({where: {hubId: hubId}})

  var ins = []
  var outs = []

  var channels = []

  var solvency = 0

  for(var d of deltas){
    var ch = await me.channel(d.userId)

    solvency += ch.delta

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

  return {
    channels: channels,
    solvency: solvency,
    ins: ins,
    outs: outs
  }



}