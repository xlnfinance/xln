// chain has blocks, block has batches, batch has transactions

module.exports = async (args) => {
  return await section('onchain', async () => {
    //l('Start process chain')

    if (!cached_result.sync_started_at) {
      cached_result.sync_started_at = K.total_blocks
      cached_result.sync_tx_started_at = K.total_tx
      cached_result.sync_progress = 0
      var startHrtime = hrtime()
    }

    if (argv.nocrypto) {
      var original_state = await onchain_state()
    }

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
        l(
          `Not properly cross-linked chain: ${K.total_blocks} ${readInt(
            total_blocks
          )}`
        )
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

      if (argv.nocrypto) {
        if (K.total_blocks >= parseInt(argv.stop_blocks)) {
          // show current state hash and quit
          let final_state = await onchain_state()

          let msg = {
            original: trim(original_state, 8),
            total_blocks: K.total_blocks,
            final: trim(final_state, 8),
            benchmark: ((hrtime() - startHrtime) / 1000000).toFixed(6)
          }

          Raven.captureMessage('SyncDone', {
            level: 'info',
            extra: msg,
            tags: msg
          })

          l('Result: ' + (msg.final == 'b84905fe'))

          setTimeout(() => {
            fatal('done')
          }, 1000)

          return
        }
      }
    }

    end()

    if (K.total_blocks - cached_result.sync_started_at <= 0) {
      return
    }

    // dirty hack to not backup k.json until all blocks are synced
    if (args.length >= K.sync_limit) {
      //return
    }

    // are we completely synced now?
    if (K.ts + K.blocktime * 2 > ts()) {
      if (
        cached_result.sync_started_at &&
        K.total_blocks - cached_result.sync_started_at > 100
      ) {
        react({confirm: 'New blocks synced and validated!'})
      }
      cached_result.sync_started_at = false
      cached_result.sync_tx_started_at = false
    } else {
      l('So many blocks. Syncing one more time')
      //Periodical.syncChain()
    }

    //
    //Periodical.updateCache()
    react({})

    // Ensure our last broadcasted batch was added
    if (PK.pending_batch) {
      const raw = fromHex(PK.pending_batch)
      l('Rebroadcasting pending tx ', raw.length)
      react({
        alert: "Transaction wasn't included, rebroadcasting...",
        force: true
      })

      me.send(nextValidator(true), 'tx', r([raw]))
      return
    }

    // time to broadcast our next batch then. (Delay to ensure validator processed the block)
    /*
    if (me.my_hub) {
      setTimeout(() => {
        Periodical.broadcast()
      }, 2000)
    }
    */
  })
}
