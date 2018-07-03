module.exports = async (args) => {
  q('onchain', async () => {
    let started = K.total_blocks
    //l(`Sync since ${started} ${args.length}`)
    for (let block of args) {
      if (!(await me.processBlock(block[0], block[1], block[2]))) {
        l('Bad chain?')
        break
      }
    }

    if (K.total_blocks - started > 0) {
      // dirty hack to not backup k.json until all blocks are synced
      if (args.length >= K.sync_limit) {
        l('So many blocks. Syncing one more time')
        sync()
      } else {
        update_cache()
        react({}, false)

        // Ensure our last broadcasted batch was added
        if (PK.pending_batch) {
          let raw = fromHex(PK.pending_batch)
          l('Rebroadcasting pending tx ', raw.length)
          me.send(me.next_member(true), 'tx', r([raw]))
        } else {
          // time to broadcast our next batch then. (Delay to ensure validator processed the block)
          setTimeout(() => {
            me.broadcast()
          }, 2000)
        }
      }
    }
  })
}
