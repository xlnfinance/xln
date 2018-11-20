// Verify and apply transactions to current state.
// Since we aim to be a settlement layer executed on *all* machines, transactions are sent in big signed batches to optimize load - only 1 batch per user per block is allowed

// Blockchain consists of blocks, blocks consist of batches sent by users, batches consist of transactions

// some big tx handlers are in separate tx/* files
const Tx = {
  withdrawFrom: require('./tx/withdraw_from'),
  depositTo: require('./tx/deposit_to'),
  disputeWith: require('./tx/dispute_with'),

  createOrder: require('./tx/create_order'),
  createAsset: require('./tx/create_asset'),
  createHub: require('./tx/create_hub'),

  propose: require('./tx/propose'),
  vote: require('./tx/vote')
}

Tx.revealSecrets = async (s, args) => {
  // someone tries to cheat in an atomic payment? Reveal the secrets onchain and dispute!
  // can be used not just for channels but any atomic actions. Stored according to Sprites approach
  for (const secret of args) {
    const hash = sha3(secret)
    const hl = await Hashlock.findOne({
      where: {
        hash: hash
      }
    })

    if (hl) {
      // make it live longer
      hl.delete_at += K.hashlock_keepalive
      await hl.save()
    } else {
      await Hashlock.create({
        hash: hash,
        revealed_at: K.usable_blocks,
        // we don't want the evidence to be stored forever, obviously
        delete_at: K.usable_blocks + K.hashlock_keepalive
      })
      s.parsed_tx.events.push(['revealSecrets', hash])
    }
  }
}

Tx.cancelOrder = async (s, args) => {
  const id = readInt(args)
  const order = await Order.findOne({where: {id: id, userId: s.signer.id}})
  if (!order) {
    l('No such order for signer')
    return
  }
  // credit the order amount back to the creator
  userAsset(s.signer, order.assetId, order.amount)
  await order.destroy()
}

module.exports = async (s, batch) => {
  let [id, sig, body] = r(batch)

  s.signer = await getUserByIdOrKey(readInt(id))

  if (!s.signer || !s.signer.id) {
    l(id, s.signer)
    return {error: "This user doesn't exist"}
  }

  if (!ec.verify(body, sig, s.signer.pubkey)) {
    return {error: `Invalid tx signature.`}
  }

  let [methodId, batch_nonce, gaslimit, gasprice, transactions] = r(body)
  ;[methodId, batch_nonce, gaslimit, gasprice] = [
    methodId,
    batch_nonce,
    gaslimit,
    gasprice
  ].map(readInt)

  if (methodMap(methodId) != 'batch') {
    return {error: 'Only batched tx are supported'}
  }

  if (gasprice < K.min_gasprice) {
    return {error: 'Gasprice offered is below minimum'}
  }

  // gas/fees estimation is very straighforward for now, later methods' pricing can be fine tuned
  let gas = batch.length
  let txfee = Math.round(gasprice * gas)

  // only asset=1 balance is used for fees
  if (userAsset(s.signer, 1) < txfee) {
    return {error: 'Not enough FRD balance to cover tx fee'}
  }

  // This is just checking, so no need to apply
  if (s.dry_run) {
    if (s.meta[s.signer.id]) {
      // Why only 1 tx/block? Two reasons:
      // * it's an extra hassle to ensure the account has money to cover subsequent w/o applying old ones. It would require fast rollbacks / reorganizations
      // * The system intends to work as a rarely used layer, so people should batch transactions in one to make them cheaper and smaller anyway
      return {error: 'Only 1 tx per block per user allowed'}
    } else {
      if (s.signer.batch_nonce != batch_nonce) {
        return {
          error: `Invalid batch_nonce dry_run ${
            s.signer.batch_nonce
          } vs ${batch_nonce}`
        }
      }

      // Mark this user to deny subsequent tx
      if (!s.meta[s.signer.id]) s.meta[s.signer.id] = 1

      return {success: true, gas: gas, gasprice: gasprice, txfee: txfee}
    }
  } else {
    if (s.signer.batch_nonce != batch_nonce) {
      return {
        error: `Invalid batch_nonce ${s.signer.batch_nonce} vs ${batch_nonce}`
      }
    }
  }

  // Tx is valid, can take the fee
  userAsset(s.signer, 1, -txfee)
  userAsset(s.meta.proposer, 1, txfee)

  if (me.is_me(s.signer.pubkey)) {
    me.addEvent({
      type: 'onchainfee',
      desc: `Our tx was included and fee taken`,
      amount: txfee
    })
  }

  K.collected_fees += txfee

  s.parsed_tx = {
    signer: s.signer,
    batch_nonce: batch_nonce,
    gas: gas,
    gasprice: gasprice,
    txfee: txfee,

    length: batch.length,

    // valid and executed events
    events: []
  }

  // transaction consists of short id and array of args
  for (const [methodId, args] of transactions) {
    const methodName = methodMap(readInt(methodId))

    if (Tx[methodName]) {
      let end = perf(methodName)
      // pass state and tx to apply
      await Tx[methodName](s, args)
      end()
    }
  }

  s.signer.batch_nonce++
  await saveId(s.signer)

  s.meta['parsed_tx'].push(s.parsed_tx)

  if (me.is_me(s.signer.pubkey)) {
    if (PK.pending_batch == toHex(batch)) {
      //l('Added to chain')
      //react({confirm: 'Your onchain transaction has been added!'}, false)
      PK.pending_batch = null
    }
  }

  return {success: true}
}
