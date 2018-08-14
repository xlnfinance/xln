module.exports = async (ws, args) => {
  //args are: network name, prev hash, total_blocks, limit
  if (K.prev_hash == toHex(args[1]) || K.network_name != args[0].toString()) {
    // sender is on last block OR wrong network
    return false
  }

  let limit = readInt(args[3]) //K.sync_limit

  let last = await Block.findOne({
    attributes: ['id'],
    where: {
      prev_hash: args[1]
    }
  })

  if (last) {
    let chain = (await Block.findAll({
      attributes: ['precommits', 'header', 'ordered_tx_body'],
      where: {
        id: {[Op.gte]: last.id}
      },
      order: [['id', 'ASC']],
      limit: limit
    })).map((b) => {
      // only include precommits in the last one
      return [r(b.precommits), b.header, b.ordered_tx_body]
    })

    ws.send(concat(bin(methodMap('chain')), r(chain)), wscb)
  } else {
    // l("No blocks to sync after " + msg.toString('hex'))
  }
}
