const getChain = require('./get_chain')

module.exports = async (ws, args) => {
  //args are: network name, prev hash, total_blocks, limit

  /*
  if (K.prev_hash == toHex(args[1]) || K.network_name != args[0].toString()) {
    // sender is on last block OR wrong network
    return false
  }


  let their_block = await Block.findOne({
    attributes: ['id'],
    where: {
      prev_hash: args[1]
    }
  })
  if (their_block) {

  */

  let raw_chain = await getChain({
    their_block: readInt(args[2]),
    limit: readInt(args[3])
  })

  if (raw_chain.length > 3) {
    ws.send(concat(bin(methodMap('chain')), raw_chain), wscb)
  } else {
    //l('No blocks to sync after ')
  }
}
