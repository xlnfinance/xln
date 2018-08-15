// chain has blocks, block has batches, batch has transactions

module.exports = async (args) => {
  return section('onchain', async () => {
    if (!cached_result.sync_started_at)
      cached_result.sync_started_at = K.total_blocks

    let end = perf('processChain')
    //l(`Sync since ${cached_result.sync_started_at} ${args.length}`)

    // step 1: ensure entire chain is cross-linked with prev_hash
    // we don't check precommits yet

    let our_prev_hash = fromHex(K.prev_hash)
    for (const block of args) {
      let [
        methodId,
        built_by,
        total_blocks,
        prev_hash,
        timestamp,
        tx_root,
        db_hash
      ] = r(block[1])

      if (prev_hash.equals(our_prev_hash)) {
        // hash of next header
        our_prev_hash = sha3(block[1])
      } else {
        l('Not properly cross-linked chain')
        return
      }
    }

    // s means state (like ENV) - it is passed down to block, batch and every tx
    var s = {
      missed_validators: [],
      dry_run: false
    }

    // // step 2: last block has valid precommits (no need to check sigs on each block)
    let last_block = args[args.length - 1]

    let shares = 0
    let precommit_body = r([methodMap('precommit'), last_block[1]])
    for (let i = 0; i < Validators.length; i++) {
      if (
        last_block[0][i] &&
        last_block[0][i].length == 64 &&
        ec.verify(precommit_body, last_block[0][i], Validators[i].block_pubkey)
      ) {
        shares += Validators[i].shares
      } else {
        s.missed_validators.push(Validators[i].id)
      }
    }

    if (shares < K.majority) {
      return l(`Not enough precommits on entire chain: ${shares}`)
    }

    // step 3: if entire chain is precommited, process blocks one by one
    for (const block of args) {
      s.precommits = block[0]
      if (!(await me.processBlock(s, block[1], block[2]))) {
        l('Bad chain?')
        break
      }
    }

    end()

    if (K.total_blocks - cached_result.sync_started_at <= 0) {
      return
    }

    // dirty hack to not backup k.json until all blocks are synced
    if (args.length >= K.sync_limit) {
      l('So many blocks. Syncing one more time')
      //sync()
      //return
    }

    if (K.ts + K.blocktime * 2 > ts()) {
      cached_result.sync_started_at = false

      react({confirm: 'New blocks synced and validated!'})
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
