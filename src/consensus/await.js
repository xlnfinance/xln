module.exports = () => {
  me.status = 'await'

  // if have 2/3+ precommits, commit the block and share
  let shares = 0
  const precommits = []
  Validators.map((c, index) => {
    if (c.precommit) {
      shares += c.shares
      precommits[index] = c.precommit
    } else {
      precommits[index] = 0
    }

    // flush sigs for next round
    c.prevote = null
    c.precommit = null
  })

  if (shares < K.majority) {
    if (!me.proposed_block.locked) me.proposed_block = {}

    l(`Failed to commit, only ${shares} precommits / ${K.majority}. Lets sync`)
    sync()
  } else if (me.proposed_block.header) {
    // adding to our external queue to avoid race conditions
    // we don't call processBlock directly to avoid races
    me.processChain([
      [precommits, me.proposed_block.header, me.proposed_block.ordered_tx_body]
    ])
    me.proposed_block = {}
  }
}
