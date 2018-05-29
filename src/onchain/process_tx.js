// Verify and apply transactions to current state.
// Since we aim to be a settlement layer executed on *all* machines, transactions are sent in big signed batches to optimize load - only 1 batch per user per block is allowed

module.exports = async (tx, meta) => {
  var [id, sig, body] = r(tx)

  var signer = await User.findById(readInt(id))

  if (!signer) {
    return {error: "This user doesn't exist"}
  }

  if (!ec.verify(body, sig, signer.pubkey)) {
    return {error: `Invalid tx signature.`}
  }

  var [methodId, nonce, transactions] = r(body)
  nonce = readInt(nonce)
  var asset = 1 // default asset id, can be changed many times with setAsset directive

  if (methodMap(readInt(methodId)) != 'batch') {
    return {error: 'Only batched tx are supported'}
  }

  // gas/tax estimation is very straighforward for now, later methods' pricing can be fine tuned
  var tax = Math.round(K.tax * tx.length)

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
          error: `Invalid nonce during dry run ${signer.nonce} vs ${nonce}`
        }
      }

      // Mark this user to deny subsequent tx
      if (!meta[signer.id]) meta[signer.id] = 1

      return {success: true}
    }
  } else {
    if (signer.nonce != nonce) {
      return {error: 'Invalid nonce'}
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

  var parsed_tx = {
    signer: signer,
    nonce: nonce,
    tax: tax,
    length: tx.length,

    // valid and executed events
    events: []
  }

  // at some point, we should apply strategy pattern here.
  // For now it is easier to refer local vars with if/else if cascade.
  for (var t of transactions) {
    var method = methodMap(readInt(t[0]))

    if (method == 'setAsset') {
      // all subsequent transactions are now implied to use this asset
      // ensure this asset exists
      let assetRecord = await Asset.findById(readInt(t[1][0]))
      if (assetRecord) {
        asset = assetRecord.id
        parsed_tx.events.push([method, asset])
      }
    } else if (method == 'withdrawFrom') {
      // withdraw money from a channel by providing a sig of your partner
      // you can only withdraw from insured balance

      for (var input of t[1]) {
        var amount = readInt(input[0])

        var partner = await User.idOrKey(input[1])
        if (!partner || !partner.id) {
          l('Cant withdraw from nonexistent partner')
          continue
        }

        var compared = Buffer.compare(signer.pubkey, partner.pubkey)
        if (compared == 0) continue

        var ins = await Insurance.findOne({
          where: {
            leftId: compared == -1 ? signer.id : partner.id,
            rightId: compared == -1 ? partner.id : signer.id,
            asset: asset
          }
        })

        if (!ins || amount > ins.insurance) {
          l(`Invalid amount ${ins.insurance} vs ${amount}`)
          continue
        }

        var body = r([
          methodMap('withdrawFrom'),
          ins.leftId,
          ins.rightId,
          ins.nonce,
          amount,
          ins.asset
        ])

        if (!ec.verify(body, input[2], partner.pubkey)) {
          l('Invalid withdrawal sig by partner ', ins.nonce, input)
          continue
        }

        // for blockchain explorer
        parsed_tx.events.push([method, amount, partner.id])
        meta.inputs_volume += amount // todo: asset-specific

        ins.insurance -= amount
        // if signer is left and reduces insurance, move ondelta to the left too
        // .====| reduce insurance .==--| reduce ondelta .==|
        if (compared == -1) ins.ondelta -= amount

        signer.asset(asset, amount)

        ins.nonce++

        await ins.save()

        // was this input related to us?
        if (me.record && [partner.id, signer.id].includes(me.record.id)) {
          var ch = await me.getChannel(
            me.record.id == partner.id ? signer.pubkey : partner.pubkey,
            asset
          )
          // they planned to withdraw and they did. Nullify hold amount
          ch.d.they_input_amount = 0
          ch.d.input_amount = 0
          ch.d.input_sig = null

          ch.ins = ins

          if (argv.syncdb) ch.d.save()
        }
      }
    } else if (method == 'revealSecrets') {
      // someone tries to cheat in an atomic payment? Reveal the secrets onchain and dispute!
      // can be used not just for channels but any atomic actions. Stored according to Sprites approach
      for (var secret of t[1]) {
        var hash = sha3(secret)
        var hl = await Hashlock.findOne({
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
          parsed_tx.events.push(['revealSecrets', hash])
        }
      }
    } else if (method == 'disputeWith') {
      // our partner is unresponsive, so we provide dispute proof/state (signed offdelta, nonce, hashlocks etc all in one)
      for (let dispute of t[1]) {
        var [id, sig, state] = dispute

        var partner = await User.idOrKey(id)
        if (!partner || !partner.id) {
          l('Your partner is not registred')
          await partner.save()
        }

        var compared = Buffer.compare(signer.pubkey, partner.pubkey)
        if (compared == 0) {
          l('Cannot dispute with yourself')
          continue
        }

        var ins = (await Insurance.findOrBuild({
          where: {
            leftId: compared == -1 ? signer.id : partner.id,
            rightId: compared == -1 ? partner.id : signer.id,
            asset: asset
          },
          include: {all: true}
        }))[0]

        if (sig) {
          if (!ec.verify(state, sig, partner.pubkey)) {
            l('Invalid sig ', state)
            continue
          }

          // see Delta.prototype.getState to see how state it's built
          var [
            methodId,
            [leftId, rightId, dispute_nonce, offdelta, dispute_asset],
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
            continue
          }

          var dispute_nonce = readInt(dispute_nonce)
          var offdelta = readInt(offdelta) // SIGNED int
          var hashlocks = r([left_inwards, right_inwards])
        } else {
          l('New channel? Split with default values')
          var dispute_nonce = 0
          var offdelta = 0
          var hashlocks = null
        }
        if (ins.dispute_nonce && dispute_nonce <= ins.dispute_nonce) {
          l(`New nonce in dispute must be higher ${asset}`)
          continue
        }

        if (ins.dispute_delayed) {
          // the other party sends counterproof
          if (ins.dispute_left == (compared == 1)) {
            // TODO: any punishment for cheating for starting party?
            // we don't want to slash everything like in LN, but some fee would help
            ins.dispute_hashlocks = hashlocks

            ins.dispute_nonce = dispute_nonce
            ins.dispute_offdelta = offdelta

            parsed_tx.events.push([
              method,
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

          parsed_tx.events.push([
            method,
            partner.id,
            'started',
            ins,
            resolveChannel(ins.insurance, ins.ondelta + offdelta)
          ])

          await ins.save()

          if (me.is_me(partner.pubkey)) {
            l('Channel with us is disputed')
            // now our job is to ensure our inward hashlocks are unlocked and that we get most profitable outcome
            var ch = await me.getChannel(signer.pubkey, asset)
            ch.d.status = 'disputed'
            await ch.d.save()
            var our_nonce = ch.d.signed_state
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
    } else if (method == 'depositTo') {
      // deposit from our onchain balance to another onchain balance or channel from some side
      await signer.payDebts(asset, parsed_tx)
      // there's a tiny bias here, the hub always gets reimbursed more than tax paid
      // todo: consider splitting tax based on % in total output volume
      var reimburse_tax = 1 + Math.floor(tax / t[1].length)

      for (var output of t[1]) {
        var amount = readInt(output[0])

        if (amount > signer.asset(asset)) {
          l(`Trying to deposit ${amount} but has ${signer.asset(asset)}`)
          continue
        }

        var giveTo = await User.idOrKey(output[1])
        var withPartner =
          output[2].length == 0 ? false : await User.idOrKey(output[2])

        // invoice is an arbitrary tag to identify the payer for merchant
        var invoice = output[3] && output[3].length != 0 ? output[3] : false

        // here we ensure both parties are registred, and take needed fees

        if (!giveTo || !giveTo.id) {
          // you must be registered first using asset 1
          if (asset != 1) {
            l('Not 1 asset')
            continue
          }

          if (!withPartner) {
            if (amount < K.account_creation_fee) continue

            giveTo.asset(asset, amount - K.account_creation_fee)

            signer.asset(asset, -amount)
          } else {
            if (!withPartner.id) {
              l("Both partners don't exist")
              continue
            }

            var fee = K.standalone_balance + K.account_creation_fee
            if (amount < fee) continue

            giveTo.asset(asset, K.standalone_balance)
            amount -= fee
            //signer.asset(asset, -fee)
          }

          await giveTo.save()

          K.collected_tax += K.account_creation_fee
        } else {
          if (withPartner) {
            if (!withPartner.id) {
              // the partner is not registred yet

              var fee = K.standalone_balance + K.account_creation_fee
              if (amount < fee) continue
              if (asset != 1) {
                l('Not 1 asset')
                continue
              }

              withPartner.asset(asset, K.standalone_balance)
              amount -= fee
              //signer.asset(asset, -fee)
              await withPartner.save()
              // now it has id

              /*

              if (me.is_me(withPartner.pubkey)) {
                await me.addHistory(
                  giveTo.pubkey,
                  -K.account_creation_fee,
                  'Account creation fee'
                )
                await me.addHistory(
                  giveTo.pubkey,
                  -K.standalone_balance,
                  'Minimum global balance'
                )
              }
              */
            }
          } else {
            if (giveTo.id == signer.id) {
              l('Trying to deposit to your onchain balance is pointless')
              continue
            }
            giveTo.asset(asset, amount)
            signer.asset(asset, -amount)
            await giveTo.save()
          }
        }

        if (withPartner && withPartner.id) {
          var compared = Buffer.compare(giveTo.pubkey, withPartner.pubkey)
          if (compared == 0) continue

          var ins = (await Insurance.findOrBuild({
            where: {
              leftId: compared == -1 ? giveTo.id : withPartner.id,
              rightId: compared == -1 ? withPartner.id : giveTo.id,
              asset: asset
            }
          }))[0]

          ins.insurance += amount
          if (compared == -1) ins.ondelta += amount

          // user is paying themselves for registration
          var regfees = readInt(output[0]) - amount
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

          await ins.save()

          if (me.is_me(withPartner.pubkey) || me.is_me(giveTo.pubkey)) {
            // hot reload
            // todo ensure it's in memory yet
            var ch = await me.getChannel(
              me.is_me(withPartner.pubkey) ? giveTo.pubkey : withPartner.pubkey,
              asset
            )
            ch.ins = ins
          }

          // rebalance by hub for our account = reimburse hub fees
          /*
          if (me.is_me(withPartner.pubkey)) {
            await me.addHistory(
              giveTo.pubkey,
              -reimburse_tax,
              'Rebalance fee',
              true
            )
          }
          */
        }

        // onchain payment for specific invoice (to us or one of our channels)
        if (me.is_me(giveTo.pubkey) && invoice) {
          // TODO: hook into SDK

          l('Invoice paid on chain ', invoice)
        }

        parsed_tx.events.push([
          method,
          amount,
          giveTo.id,
          withPartner ? withPartner.id : false,
          invoice ? toHex(invoice) : false
        ])

        meta.outputs_volume += amount
      }
    } else if (method == 'createAsset') {
      var [ticker, amount] = t[1]
      amount = readInt(amount)
      ticker = ticker.toString().replace(/[^a-zA-Z0-9]/g, '') // from buffer to unicode, sanitize

      if (ticker.length < 3) {
        l('Too short ticker')
        continue
      }

      var exists = await Asset.findOne({where: {ticker: ticker}})
      if (exists) {
        if (exists.issuerId == signer.id) {
          //minting new tokens to issuer's onchain balance
          exists.total_supply += amount
          signer.asset(exists.id, amount)
          await exists.save()

          parsed_tx.events.push([method, ticker, amount])
        } else {
          l('Invalid issuer tries to mint')
        }
      } else {
        var new_asset = await Asset.create({
          issuerId: signer.id,
          ticker: ticker,
          total_supply: amount,

          name: t[1][2] ? t[1][2].toString() : '',
          desc: t[1][3] ? t[1][3].toString() : ''
        })

        signer.asset(new_asset.id, amount)
        parsed_tx.events.push([
          method,
          new_asset.ticker,
          new_asset.total_supply
        ])
      }
    } else if (method == 'createHub') {
    } else if (method == 'createOrder') {
      // onchain exchange to sell an asset for another one.
      var [assetId, amount, buyAssetId, rate] = t[1].map(readInt)
      var round = Math.round
      rate = rate / 1000000 // convert back from integer

      var direct_order = assetId > buyAssetId

      let sellerOwns = signer.asset(assetId)

      if (sellerOwns < amount) {
        l('Trying to sell more then signer has')
        continue
      }

      signer.asset(assetId, -amount)

      var order = Order.build({
        amount: amount,
        rate: rate,
        userId: signer.id,
        assetId: assetId,
        buyAssetId: buyAssetId
      })

      // now let's try orders with same rate or better

      var orders = await Order.findAll({
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

      for (var their of orders) {
        if (direct_order) {
          var they_buy = round(their.amount / their.rate)
          var we_buy = round(order.amount * their.rate)
        } else {
          var they_buy = round(their.amount * their.rate)
          var we_buy = round(order.amount / their.rate)
        }

        //l('Suitable order', we_buy, they_buy, their)

        var seller = await User.findById(their.userId)
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
        await seller.save()
      }

      if (order.amount > 0) {
        // is new order still not fullfilled? keep in orderbook
        await order.save()
      } else {
        // doesn't even exist yet
      }

      parsed_tx.events.push([method, assetId, amount, buyAssetId, rate])
    } else if (method == 'cancelOrder') {
      var id = readInt(t[1][0])
      var order = await Order.findOne({where: {id: id, userId: signer.id}})
      if (!order) {
        l('No such order for signer')
        continue
      }
      // credit the order amount back to the creator
      signer.asset(order.assetId, order.amount)
      await order.destroy()
    } else if (method == 'propose') {
      // temporary protection
      //if (signer.id != 1)
      continue

      var execute_on = K.usable_blocks + K.voting_period // 60*24

      var new_proposal = await Proposal.create({
        desc: t[1][0].toString(),
        code: t[1][1].toString(),
        patch: t[1][2].toString(),
        kindof: method,
        delayed: execute_on,
        userId: signer.id
      })

      parsed_tx.events.push([method, new_proposal])

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
    } else if (method == 'vote') {
      var [proposalId, approval, rationale] = t[1]
      var vote = await Vote.findOrBuild({
        where: {
          userId: signer.id,
          proposalId: readInt(proposalId)
        }
      })
      vote = vote[0]

      vote.rationale = rationale.toString()
      vote.approval = approval[0] == 1

      await vote.save()
      parsed_tx.events.push([method, vote])
      l(`Voted ${vote.approval} for ${vote.proposalId}`)
    }
  }

  signer.nonce++
  await signer.save()

  meta['parsed_tx'].push(parsed_tx)

  return {success: true}
}
