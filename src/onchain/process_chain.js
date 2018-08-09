// chain has blocks, block has batches, batch has transactions

module.exports = async (args) => {
  return section('onchain', async () => {
    const started = K.total_blocks
    //l(`Sync since ${started} ${args.length}`)

    for (const block of args) {
      if (!(await me.processBlock(block[0], block[1], block[2]))) {
        l('Bad chain?')
        break
      }
    }

    if (K.total_blocks - started <= 0) {
      return
    }

    // dirty hack to not backup k.json until all blocks are synced
    if (args.length >= K.sync_limit) {
      l('So many blocks. Syncing one more time')
      sync()
      return
    }

    //
    update_cache()
    react({}, false)

    // Ensure our last broadcasted batch was added
    if (PK.pending_batch) {
      const raw = fromHex(PK.pending_batch)
      l('Rebroadcasting pending tx ', raw.length)
      me.send(nextValidator(true), 'tx', r([raw]))
      return
    }

    // time to broadcast our next batch then. (Delay to ensure validator processed the block)
    if (me.my_hub && argv.rebalance) {
      setTimeout(() => {
        me.broadcast()
      }, 2000)
    }
  })
}
