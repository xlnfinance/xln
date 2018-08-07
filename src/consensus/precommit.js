module.exports = () => {
  me.status = 'precommit'

  // gossip your precommits if have 2/3+ prevotes or nil

  // do we have enough prevotes?
  let shares = 0
  Validators.map((c, index) => {
    if (c.prevote) {
      shares += c.shares
    }
  })

  let precommitable = 0
  if (shares >= K.majority) {
    precommitable = me.proposed_block.header

    // lock on this block. Unlock only if another block gets 2/3+
    me.proposed_block.locked = true
  }

  if (me.CHEAT_dontprecommit) {
    //l('We are in CHEAT and dont precommit ever')
    return
  }

  setTimeout(() => {
    me.gossip(
      'precommit',
      me.block_envelope(methodMap('precommit'), precommitable)
    )
  }, K.gossip_delay)
}
