// Verify and apply transactions to current state.
// Since we aim to be a settlement layer executed on *all* machines, transactions are sent in big signed batches to optimize load - only 1 batch per user per block is allowed

// Blockchain consists of blocks, blocks consist of batches sent by users, batches consist of transactions

// some big tx handlers are in separate tx/* files
const withdrawFrom = require('./tx/withdraw_from')
const depositTo = require('./tx/deposit_to')
const disputeWith = require('./tx/dispute_with')
const createOrder = require('./tx/create_order')
const createAsset = require('./tx/create_asset')
const propose = require('./tx/propose')
const vote = require('./tx/vote')

const setAsset = async (global_state, tr) => {
  // all subsequent transactions are now implied to use this asset
  // ensure this asset exists
  const assetRecord = await Asset.findById(readInt(tr[1][0]))
  if (assetRecord) {
    const asset = assetRecord.id
    global_state.asset = asset
    global_state.events.push(['setAsset', asset])
  }
}

const revealSecrets = async (global_state, tr) => {
  // someone tries to cheat in an atomic payment? Reveal the secrets onchain and dispute!
  // can be used not just for channels but any atomic actions. Stored according to Sprites approach
  for (const secret of tr[1]) {
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
      global_state.events.push(['revealSecrets', hash])
    }
  }
}

const cancelOrder = async (tr, signer) => {
  const id = readInt(tr[1][0])
  const order = await Order.findOne({where: {id: id, userId: signer.id}})
  if (!order) {
    l('No such order for signer')
    return
  }
  // credit the order amount back to the creator
  signer.asset(order.assetId, order.amount)
  await order.destroy()
}

module.exports = async (tx, meta) => {
  let [id, sig, body] = r(tx)

  let signer = await User.idOrKey(readInt(id))

  if (!signer || !signer.id) {
    l(id, signer)
    return {error: "This user doesn't exist"}
  }

  if (!ec.verify(body, sig, signer.pubkey)) {
    return {error: `Invalid tx signature.`}
  }

  let [methodId, nonce, gaslimit, gasprice, transactions] = r(body)
  ;[methodId, nonce, gaslimit, gasprice] = [
    methodId,
    nonce,
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
  let gas = tx.length
  let txfee = Math.round(gasprice * gas)

  // only asset=1 balance is used for fees
  if (signer.asset(1) < txfee) {
    return {error: 'Not enough FRD balance to cover tx fee'}
  }

  // This is just checking, so no need to apply
  if (meta.dry_run) {
    if (meta[signer.id]) {
      // Why only 1 tx/block? Two reasons:
      // * it's an extra hassle to ensure the account has money to cover subsequent w/o applying old ones. It would require fast rollbacks / reorganizations
      // * The system intends to work as a rarely used layer, so people should batch transactions in one to make them cheaper and smaller anyway
      return {error: 'Only 1 tx per block per user allowed'}
    } else {
      if (signer.nonce != nonce) {
        return {
          error: `Invalid nonce dry_run ${signer.nonce} vs ${nonce}`
        }
      }

      // Mark this user to deny subsequent tx
      if (!meta[signer.id]) meta[signer.id] = 1

      return {success: true, gas: gas, gasprice: gasprice, txfee: txfee}
    }
  } else {
    if (signer.nonce != nonce) {
      return {error: `Invalid nonce ${signer.nonce} vs ${nonce}`}
    }
  }

  if (me.is_me(signer.pubkey)) {
    if (PK.pending_batch == toHex(tx)) {
      //l('Added to chain')
      react({confirm: 'Your onchain transaction has been added!'}, false)
      PK.pending_batch = null
    }
  }

  // Tx is valid, can take the fee
  signer.asset(1, -txfee)
  meta.proposer.asset(1, txfee)

  K.collected_fees += txfee

  const parsed_tx = {
    signer: signer,
    nonce: nonce,
    gas: gas,
    gasprice: gasprice,
    txfee: txfee,

    length: tx.length,

    // valid and executed events
    events: []
  }

  const state = {
    asset: 1, // default asset id, can be changed many times with setAsset directive
    events: []
  }

  for (const t of transactions) {
    const method = methodMap(readInt(t[0]))
    switch (method) {
      case 'setAsset':
        await setAsset(state, t)
        break
      case 'withdrawFrom':
        await withdrawFrom(state, t, signer, meta)
        break
      case 'revealSecrets':
        await revealSecrets(state, t)
        break
      case 'disputeWith':
        await disputeWith(state, t, signer)
        break
      case 'depositTo':
        await depositTo(state, t, signer, meta, txfee)
        break
      case 'createAsset':
        await createAsset(state, t, signer)
        break
      case 'createHub':
        // not implemented
        break
      case 'createOrder':
        await createOrder(state, t, signer)
        break
      case 'cancelOrder':
        await cancelOrder(t, signer)
        break
      case 'propose':
        await propose(state, signer)
        break
      case 'vote':
        await vote(state, t, signer)
        break
    }
  }

  signer.nonce++
  await saveId(signer)

  parsed_tx.events = state.events

  meta['parsed_tx'].push(parsed_tx)

  return {success: true}
}
