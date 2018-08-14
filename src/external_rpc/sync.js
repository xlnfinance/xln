module.exports = async (ws, args) => {
  //args are: network name, prev hash, total_blocks, limit
  if (K.prev_hash == toHex(args[1]) || K.network_name != args[0].toString()) {
    // sender is on last block OR wrong network
    return false
  }

  let limit = readInt(args[3]) //K.sync_limit

  let their_block = await Block.findOne({
    attributes: ['id'],
    where: {
      prev_hash: args[1]
    }
  })

  if (their_block) {
    let block_records = await Block.findAll({
      attributes: ['precommits', 'header', 'ordered_tx_body'],
      where: {
        id: {[Op.gte]: their_block.id}
      },
      order: [['id', 'ASC']],
      limit: limit
    })

    let chain = block_records.map((b) => {
      return [null, b.header, b.ordered_tx_body]
    })

    // only include precommits in the last one, not in each
    let last_block = chain.length - 1
    chain[last_block][0] = r(block_records[last_block].precommits)

    ws.send(concat(bin(methodMap('chain')), r(chain)), wscb)
  } else {
    // l("No blocks to sync after " + msg.toString('hex'))
  }
}
