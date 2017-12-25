module.exports = async function(){
  l("Matching senders and receivers...")

  var hubId = 1

  var spent = await Delta.findAll({
    where: {
      hubId: hubId,
      delta: {
        [Sequelize.Op.lte]: -K.risk
      }
  }})

  var ins = []
  for(var d of spent){
    ins.push(spent.sig)
  }

  risky = await Delta.findAll({
    where: {
      hubId: hubId,
      delta: {
        [Sequelize.Op.gte]: K.risk
      }
  }})

  var outs = []

  for(var d of risky){
    outs.push([d.userId, hubId, d.delta])
  }
  
  if(ins.length > 0 || outs.length > 0){
    l('Found matches')
    await me.broadcast('settle', r([Buffer([0]), ins, outs]))
  }


}