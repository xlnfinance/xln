module.exports = async (ws, args) => {
  if (K.prev_hash == toHex(args[0])) {
    // sender is on last block
    return false
  }

  let last = await Block.findOne({
    attributes: ['id'],
    where: {
      prev_hash: args[0]
    }
  })

  if (last) {
    let chain = (await Block.findAll({
      attributes: ['precommits', 'header', 'ordered_tx_body'],
      where: {
        id: {[Op.gte]: last.id}
      },
      order: [['id', 'ASC']],
      limit: K.sync_limit
    })).map((b) => {
      return [r(b.precommits), b.header, b.ordered_tx_body]
    })

    ws.send(concat(bin(methodMap('chain')), r(chain)), wscb)
  } else {
    // l("No blocks to sync after " + msg.toString('hex'))
  }
}
