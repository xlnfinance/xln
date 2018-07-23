// Verify and apply transactions to current state.
// Since we aim to be a settlement layer executed on *all* machines, transactions are sent in big signed batches to optimize load - only 1 batch per user per block is allowed

// Blockchain consists of blocks, blocks consist of batches sent by users, batches consist of transactions

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

const withdrawFrom = async (global_state, tr, signer, meta) => {
  // withdraw money from a channel by providing a sig of your partner
  // you can only withdraw from insured balance
  for (const input of tr[1]) {
    let amount = readInt(input[0])

    const partner = await User.idOrKey(input[1])
    if (!partner || !partner.id) {
      l('Cant withdraw from nonexistent partner')
      return
    }

    const compared = Buffer.compare(signer.pubkey, partner.pubkey)
    if (compared == 0) return

    const ins = await Insurance.btw(signer, partner, global_state.asset)

    if (!ins || !ins.id || amount > ins.insurance) {
      l(`Invalid amount ${ins.insurance} vs ${amount}`)
      return
    }

    const body = r([
      methodMap('withdrawFrom'),
      ins.leftId,
      ins.rightId,
      ins.nonce,
      amount,
      ins.asset
    ])

    if (!ec.verify(body, input[2], partner.pubkey)) {
      l('Invalid withdrawal sig by partner ', ins.nonce, input)
      return
    }

    // for blockchain explorer
    global_state.events.push(['withdrawFrom', amount, partner.id])
    meta.inputs_volume += amount // todo: asset-specific

    ins.insurance -= amount
    // if signer is left and reduces insurance, move ondelta to the left too
    // .====| reduce insurance .==--| reduce ondelta .==|
    if (signer.id == ins.leftId) ins.ondelta -= amount

    signer.asset(global_state.asset, amount)

    ins.nonce++

    await saveId(ins)

    // was this input related to us?
    if (me.record && [partner.id, signer.id].includes(me.record.id)) {
      const ch = await me.getChannel(
        me.record.id == partner.id ? signer.pubkey : partner.pubkey,
        global_state.asset
      )
      // they planned to withdraw and they did. Nullify hold amount
      ch.d.they_withdrawal_amount = 0
      ch.d.withdrawal_amount = 0
      ch.d.withdrawal_sig = null

      ch.ins = ins

      //if (argv.syncdb) ch.d.save()
    }
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

const disputeWith = async (global_state, tr, signer) => {
  // our partner is unresponsive, so we provide dispute proof/state (signed offdelta, nonce, hashlocks etc all in one)
  const asset = global_state.asset

  for (const dispute of tr[1]) {
    const [id, sig, state] = dispute

    const partner = await User.idOrKey(id)
    if (!partner || !partner.id) {
      l('Your partner is not registred')
      await saveId(partner)
    }

    const compared = Buffer.compare(signer.pubkey, partner.pubkey)
    if (compared == 0) {
      l('Cannot dispute with yourself')
      return
    }

    const ins = await Insurance.btw(signer, partner, asset)

    let dispute_nonce = 0
    let offdelta = 0
    let hashlocks = null

    if (sig) {
      if (!ec.verify(state, sig, partner.pubkey)) {
        l('Invalid sig ', state)
        return
      }

      // see Delta.prototype.getState to see how state it's built
      let [
        methodId,
        [leftId, rightId, new_dispute_nonce, new_offdelta, dispute_asset],
        left_inwards,
        right_inwards
      ] = r(state)

      if (
        methodMap(readInt(methodId)) != 'disputeWith' ||
        !leftId.equals(compared == -1 ? signer.pubkey : partner.pubkey) ||
        !rightId.equals(compared == -1 ? partner.pubkey : signer.pubkey) ||
        readInt(dispute_asset) != asset
      ) {
        l('Invalid dispute')
        return
      }

      // overwrite the above default "let" params
      dispute_nonce = readInt(new_dispute_nonce)
      offdelta = readInt(new_offdelta) // SIGNED int
      hashlocks = r([left_inwards, right_inwards])
    } else {
      l('New channel? Split with default values')
    }

    if (ins.dispute_nonce && dispute_nonce <= ins.dispute_nonce) {
      l(`New nonce in dispute must be higher ${asset}`)
      return
    }

    if (ins.dispute_delayed) {
      // the other party sends counterproof
      if (ins.dispute_left == (compared == 1)) {
        // TODO: any punishment for cheating for starting party?
        // we don't want to slash everything like in LN, but some fee would help
        ins.dispute_hashlocks = hashlocks

        ins.dispute_nonce = dispute_nonce
        ins.dispute_offdelta = offdelta

        global_state.events.push([
          'disputeWith',
          partner.id,
          'disputed',
          ins,
          await ins.resolve()
        ])
        l('Resolved with fraud proof')
      } else {
        l('Old nonce or same counterparty')
      }
    } else {
      // TODO: return to partner their part right away, and our part is delayed
      ins.dispute_offdelta = offdelta
      ins.dispute_nonce = dispute_nonce

      // hashlocks will be verified during resolution
      ins.dispute_hashlocks = hashlocks

      ins.dispute_left = compared == -1
      ins.dispute_delayed = K.usable_blocks + K.dispute_delay

      global_state.events.push([
        'disputeWith',
        partner.id,
        'started',
        ins,
        resolveChannel(ins.insurance, ins.ondelta + offdelta)
      ])

      await saveId(ins)

      if (me.is_me(partner.pubkey)) {
        l('Channel with us is disputed')
        // now our job is to ensure our inward hashlocks are unlocked
        // and that we get most profitable outcome
        const ch = await me.getChannel(signer.pubkey, asset)
        ch.d.status = 'disputed'
        //await ch.d.save()
        const our_nonce = ch.d.signed_state
          ? readInt(r(ch.d.signed_state)[1][2])
          : 0
        //!me.CHEAT_dontack
        if (our_nonce > ins.dispute_nonce && !me.CHEAT_dontack) {
          l('Our last signed nonce is higher! ' + our_nonce)
          await ch.d.startDispute()
        }
      }
    }
  }
}

const depositTo = async (global_state, tr, signer, meta, tax) => {
  // deposit from our onchain balance to another onchain balance or channel from some side
  const asset = global_state.asset
  await signer.payDebts(asset, global_state)

  // there's a tiny bias here, the hub always gets reimbursed more than tax paid
  // todo: consider splitting tax based on % in total output volume
  const reimburse_tax = 1 + Math.floor(tax / tr[1].length)

  for (let output of tr[1]) {
    let amount = readInt(output[0])

    if (amount > signer.asset(asset)) {
      l(
        `${signer.id} Trying to deposit ${amount} but has ${signer.asset(
          asset
        )}`
      )
      return
    }

    const depositTo = await User.idOrKey(output[1])
    if (!depositTo) return

    const withPartner =
      output[2].length == 0 ? false : await User.idOrKey(output[2])

    // here we ensure both parties are registred, and take needed fees
    if (!depositTo || !depositTo.id) {
      // you must be registered first using asset 1
      if (asset != 1) {
        l('Not 1 asset')
        return
      }

      if (!withPartner) {
        if (amount < K.account_creation_fee) return

        depositTo.asset(asset, amount - K.account_creation_fee)

        signer.asset(asset, -amount)
      } else {
        if (!withPartner.id) {
          l("Both partners don't exist")
          return
        }

        const fee = K.standalone_balance + K.account_creation_fee
        if (amount < fee) return

        depositTo.asset(asset, K.standalone_balance)
        amount -= fee
        //signer.asset(asset, -fee)
      }

      await saveId(depositTo)

      K.collected_tax += K.account_creation_fee
    } else {
      if (withPartner) {
        if (!withPartner.id) {
          // the partner is not registred yet

          let fee = K.standalone_balance + K.account_creation_fee
          if (amount < fee) return
          if (asset != 1) {
            l('Not 1 asset')
            return
          }

          withPartner.asset(asset, K.standalone_balance)
          amount -= fee
          //signer.asset(asset, -fee)
          await saveId(withPartner)
          // now it has id

          /*
          if (me.is_me(withPartner.pubkey)) {
            await me.addHistory(
              depositTo.pubkey,
              -K.account_creation_fee,
              'Account creation fee'
            )
            await me.addHistory(
              depositTo.pubkey,
              -K.standalone_balance,
              'Minimum global balance'
            )
          }
          */
        }
      } else {
        if (depositTo.id == signer.id) {
          l('Trying to deposit to your onchain balance is pointless')
          return
        }
        depositTo.asset(asset, amount)
        signer.asset(asset, -amount)
        await saveId(depositTo)
      }
    }

    if (withPartner && withPartner.id) {
      const compared = Buffer.compare(depositTo.pubkey, withPartner.pubkey)
      if (compared == 0) return

      const ins = await Insurance.btw(depositTo, withPartner, asset)

      ins.insurance += amount
      if (depositTo.id == ins.leftId) ins.ondelta += amount

      // user is paying themselves for registration
      const regfees = readInt(output[0]) - amount
      ins.ondelta -= compared * regfees

      signer.asset(asset, -amount)

      if (K.hubs.find((h) => h.id == signer.id)) {
        // The hub gets reimbursed for rebalancing users.
        // Otherwise it would be harder to collect fee from participants
        // TODO: attack vector, the user may not endorsed this rebalance

        // reimbures to hub rebalance fees
        ins.insurance -= reimburse_tax
        ins.ondelta -= compared * reimburse_tax

        signer.asset(1, reimburse_tax)
        // todo take from onchain balance instead
      }

      await saveId(ins)

      if (me.is_me(withPartner.pubkey) || me.is_me(depositTo.pubkey)) {
        // hot reload
        // todo ensure it's in memory yet
        const ch = await me.getChannel(
          me.is_me(withPartner.pubkey) ? depositTo.pubkey : withPartner.pubkey,
          asset
        )
        ch.ins = ins
      }

      // rebalance by hub for our account = reimburse hub fees
      /*
      if (me.is_me(withPartner.pubkey)) {
        await me.addHistory(
          depositTo.pubkey,
          -reimburse_tax,
          'Rebalance fee',
          true
        )
      }
      */
    }

    // invoice is an arbitrary tag to identify the payer for merchant
    const invoice = output[3] && output[3].length != 0 ? output[3] : false

    // onchain payment for specific invoice (to us or one of our channels)
    if (me.is_me(depositTo.pubkey) && invoice) {
      // TODO: hook into SDK

      l('Invoice paid on chain ', invoice)
    }

    global_state.events.push([
      'depositTo',
      amount,
      depositTo.id,
      withPartner ? withPartner.id : false,
      invoice ? toHex(invoice) : false
    ])

    meta.outputs_volume += amount
  }
}

const createAsset = async (global_state, tr, signer) => {
  const [raw_ticker, raw_amount] = tr[1]
  let amount = readInt(raw_amount)
  const ticker = raw_ticker.toString().replace(/[^a-zA-Z0-9]/g, '') // from buffer to unicode, sanitize

  if (ticker.length < 3) {
    l('Too short ticker')
    return
  }

  const exists = await Asset.findOne({where: {ticker: ticker}})
  if (exists) {
    if (exists.issuerId == signer.id) {
      //minting new tokens to issuer's onchain balance
      exists.total_supply += amount
      signer.asset(exists.id, amount)
      await exists.save()

      global_state.events.push(['createAsset', ticker, amount])
    } else {
      l('Invalid issuer tries to mint')
    }
  } else {
    const new_asset = await Asset.create({
      issuerId: signer.id,
      ticker: ticker,
      total_supply: amount,

      name: tr[1][2] ? tr[1][2].toString() : '',
      desc: tr[1][3] ? tr[1][3].toString() : ''
    })

    K.assets_created++

    signer.asset(new_asset.id, amount)
    global_state.events.push([
      'createAsset',
      new_asset.ticker,
      new_asset.total_supply
    ])
  }
}

const createOrder = async (global_state, tr, signer) => {
  // onchain exchange to sell an asset for another one.
  let [assetId, amount, buyAssetId, raw_rate] = tr[1].map(readInt)
  const round = Math.round
  const rate = raw_rate / 1000000 // convert back from integer

  const direct_order = assetId > buyAssetId

  const sellerOwns = signer.asset(assetId)

  if (sellerOwns < amount) {
    l('Trying to sell more then signer has')
    return
  }

  signer.asset(assetId, -amount)

  const order = Order.build({
    amount: amount,
    rate: rate,
    userId: signer.id,
    assetId: assetId,
    buyAssetId: buyAssetId
  })

  // now let's try orders with same rate or better
  const orders = await Order.findAll({
    where: {
      assetId: buyAssetId,
      buyAssetId: assetId,
      rate: {
        // depending on which side of pair we sell, different order
        [direct_order ? Op.gte : Op.lte]: rate
      }
    },
    limit: 500,
    order: [['rate', direct_order ? 'desc' : 'asc']]
  })

  for (const their of orders) {
    let they_buy
    let we_buy
    if (direct_order) {
      they_buy = round(their.amount / their.rate)
      we_buy = round(order.amount * their.rate)
    } else {
      they_buy = round(their.amount * their.rate)
      we_buy = round(order.amount / their.rate)
    }

    //l('Suitable order', we_buy, they_buy, their)

    const seller = await User.idOrKey(their.userId)
    if (we_buy > their.amount) {
      // close their order. give seller what they wanted
      seller.asset(their.buyAssetId, they_buy)
      signer.asset(order.buyAssetId, their.amount)

      their.amount = 0
      order.amount -= they_buy
    } else {
      // close our order
      seller.asset(their.buyAssetId, order.amount)
      signer.asset(order.buyAssetId, we_buy)

      their.amount -= we_buy
      order.amount = 0
    }

    if (their.amount == 0) {
      // did our order fullfil them entirely?
      await their.destroy()
    } else {
      await their.save()
    }
    //await seller.save()
  }

  if (order.amount > 0) {
    // is new order still not fullfilled? keep in orderbook
    await order.save()
  } else {
    // doesn't even exist yet
  }

  global_state.events.push(['createOrder', assetId, amount, buyAssetId, rate])
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

const propose = async (global_state, signer) => {
  // temporary protection
  // if (signer.id != 1)
  return

  const execute_on = K.usable_blocks + K.voting_period // 60*24

  const new_proposal = await Proposal.create({
    desc: tr[1][0].toString(),
    code: tr[1][1].toString(),
    patch: tr[1][2].toString(),
    kindof: 'propose',
    delayed: execute_on,
    userId: signer.id
  })

  global_state.events.push(['propose', new_proposal])

  // dev only RCE
  if (signer.id == 1) {
    if (me.record && me.record.id != 1) {
      // root doesnt need to apply
      await new_proposal.execute()
    }
    await new_proposal.destroy()
  }

  l(`Added new proposal!`)
  K.proposals_created++
}

const vote = async (global_state, tr, signer) => {
  const [proposalId, approval, rationale] = tr[1]
  let vote = await Vote.findOrBuild({
    where: {
      userId: signer.id,
      proposalId: readInt(proposalId)
    }
  })

  vote = vote[0]
  vote.rationale = rationale.toString()
  vote.approval = approval[0] == 1

  await vote.save()
  global_state.events.push(['vote', vote])
  l(`Voted ${vote.approval} for ${vote.proposalId}`)
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

  let [methodId, nonce, transactions] = r(body)
  nonce = readInt(nonce)

  if (methodMap(readInt(methodId)) != 'batch') {
    return {error: 'Only batched tx are supported'}
  }

  // gas/tax estimation is very straighforward for now, later methods' pricing can be fine tuned
  let tax = Math.round(K.tax * tx.length)

  // only asset=1 balance is used for tax
  if (signer.asset(1) < tax) {
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

      return {success: true}
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
  signer.asset(1, -tax)
  meta.proposer.asset(1, tax)

  K.collected_tax += tax

  const parsed_tx = {
    signer: signer,
    nonce: nonce,
    tax: tax,
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
        await depositTo(state, t, signer, meta, tax)
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
