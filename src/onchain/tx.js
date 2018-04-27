// Verify and apply transactions to current state.
// Since we aim to be a settlement layer executed on *all* machines, transactions are sent in big signed batches to optimize load. Also only 1 batch per block is allowed

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

  if (methodMap(readInt(methodId)) != 'batch') {
    return {error: 'Only batched tx are supported'}
  }

  // gas/tax estimation is very straighforward for now, later methods' pricing can be fine tuned
  var tax = Math.round(K.tax * tx.length)

  if (signer.balance < tax) {
    return {error: 'Not enough balance to cover tx fee'}
  }

  // This is just checking, so no need to apply
  if (meta.dry_run) {
    if (meta[signer.id]) {
      // Why only 1 tx/block? Two reasons:
      // * it's an extra hassle to ensure the account has money to cover subsequent w/o applying old ones. It would require fast rollbacks / reorganizations
      // * The system intends to work as a rarely used layer, so people should batch transactions in one to make them cheaper and smaller anyway
      return {error: 'Only few tx per block per account currently allowed'}
    } else {
      if (signer.nonce != nonce) {
        return {error: 'Invalid nonce during dry run'}
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

  if (me.pubkey.equals(signer.pubkey)) {
    if (PK.pending_batch == toHex(tx)) {
      react({confirm: 'Your onchain transaction has been added!'})
      PK.pending_batch = null
    }
  }

  // Tx is valid, can take the fee
  signer.balance -= tax
  K.collected_tax += tax

  var parsed_tx = {
    signer: signer,
    nonce: nonce,
    tax: tax,
    length: tx.length,

    // verified and executed events
    events: [],

    // governance
    proposals: [],
    votes: []
  }

  // at some point, we should apply strategy pattern here.
  // For now it is easier to refer local vars with if/else if cascade.
  for (var t of transactions) {
    var method = methodMap(readInt(t[0]))

    if (method == 'withdrawFrom') {
      //require('./methods/withdraw_from')(t[1])

      var my_hub = K.hubs.find((h) => h.id == signer.id)

      for (var input of t[1]) {
        var amount = readInt(input[0])

        var partner = await User.idOrKey(input[1])

        var compared = Buffer.compare(signer.pubkey, partner.pubkey)
        if (compared == 0) continue

        var ins = await Insurance.find({
          where: {
            leftId: compared == -1 ? signer.id : partner.id,
            rightId: compared == -1 ? partner.id : signer.id
          },
          include: {all: true}
        })

        if (!ins || amount > ins.insurance) {
          l(`Invalid amount ${ins.insurance} vs ${amount}`)
          continue
        }

        var body = r([
          methodMap('withdrawal'),
          ins.leftId,
          ins.rightId,
          ins.nonce,
          amount
        ])

        if (!ec.verify(body, input[2], partner.pubkey)) {
          l('Wrong signature by partner ', ins.nonce)
          continue
        }

        // for blockchain explorer
        parsed_tx.events.push([method, amount, partner.id])
        meta.inputs_volume += amount

        ins.insurance -= amount
        if (compared == -1) ins.ondelta -= amount

        signer.balance += amount

        ins.nonce++

        await ins.save()

        // was this input related to us?
        if (me.record) {
          if (me.record.id == partner.id) {
            var ch = await me.getChannel(signer.pubkey)
            // they planned to withdraw and they did. Nullify hold amount
            ch.d.they_input_amount = 0
            await ch.d.save()
          }

          if (me.record.id == signer.id) {
            var ch = await me.getChannel(partner.pubkey)
            // they planned to withdraw and they did. Nullify hold amount
            ch.d.input_amount = 0
            ch.d.input_sig = null
            await ch.d.save()
          }
        }
      }
    } else if (method == 'revealSecrets') {
      for (var secret of t[1]) {
        await Hashlock.create({
          hash: sha3(secret),
          revealed_at: K.usable_blocks
        })
      }
    } else if (method == 'disputeWith') {
      for (let dispute of t[1]) {
        var [id, sig, state] = dispute

        var partner = await User.findById(readInt(id))
        if (!partner) {
          l('Your partner is not registred')
          continue
        }

        var compared = Buffer.compare(signer.pubkey, partner.pubkey)
        if (compared == 0) {
          l('Cannot dispute with yourself')
          continue
        }

        var ins = (await Insurance.findOrBuild({
          where: {
            leftId: compared == -1 ? signer.id : partner.id,
            rightId: compared == -1 ? partner.id : signer.id
          },
          defaults: {
            nonce: 0,
            insurance: 0,
            ondelta: 0
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
            [leftId, rightId, nonce, offdelta, asset],
            left_inwards,
            right_inwards
          ] = r(state)

          if (
            methodMap(readInt(methodId)) != 'dispute' ||
            !leftId.equals(ins.leftId) ||
            !rightId.equals(ins.rightId)
          ) {
            l('Broken dispute')
            continue
          }

          var nonce = readInt(nonce)
          var offdelta = readInt(offdelta) // SIGNED int
          var hashlocks = r([left_inwards, right_inwards])
        } else {
          l('New channel? Split with default values')
          var nonce = 0
          var offdelta = 0
          var hashlocks = null
        }

        var offer = resolveChannel(ins.insurance, ins.ondelta + offdelta)

        if (ins.dispute_delayed) {
          if (
            nonce > ins.dispute_nonce &&
            ins.dispute_left == (compared == 1)
          ) {
            parsed_tx.events.push([method, partner.id, 'disputed', ins, offer])

            ins.dispute_offdelta = offdelta
            await ins.resolve()
            l('Resolving with fraud proof')
          } else {
            l('Old nonce or same counterparty')
          }
        } else {
          // TODO: return to partner their part right away, and our part is delayed
          ins.dispute_offdelta = offdelta
          ins.dispute_nonce = nonce

          // hashlocks will be verified during resolution
          ins.dispute_hashlocks = hashlocks

          ins.dispute_left = compared == -1
          ins.dispute_delayed = K.usable_blocks + K.dispute_delay

          parsed_tx.events.push([method, partner.id, 'started', ins, offer])

          await ins.save()

          if (me.pubkey.equals(partner.pubkey)) {
            l('Channel with us is disputed')
            var ch = await me.getChannel(signer.pubkey)
            ch.d.status = 'disputed'
            await ch.d.save()

            if (
              (ch.left && offdelta < ch.d.offdelta) ||
              (!ch.left && offdelta > ch.d.offdelta)
            ) {
              l('Unprofitable proof posted!')
              await ch.d.startDispute()
            }
          }
        }
      }
    } else if (method == 'depositTo') {
      await signer.payDebts(parsed_tx)
      var reimburse_tax = 1 + Math.floor(tax / t[1].length)

      for (var output of t[1]) {
        amount = readInt(output[0])

        if (amount > signer.balance) continue

        var giveTo = await User.idOrKey(output[1])
        var withPartner =
          output[2].length == 0 ? false : await User.idOrKey(output[2])

        // here we ensure both parties are registred, and take needed fees

        if (!giveTo.id) {
          if (!withPartner) {
            if (amount < K.account_creation_fee) continue
            giveTo.balance = amount - K.account_creation_fee

            signer.balance -= amount
          } else {
            if (!withPartner.id) continue

            var fee = K.standalone_balance + K.account_creation_fee
            if (amount < fee) continue

            giveTo.balance = K.standalone_balance
            amount -= fee
            signer.balance -= fee
          }

          await giveTo.save()

          K.collected_tax += K.account_creation_fee
        } else {
          if (withPartner) {
            if (!withPartner.id) {
              var fee = K.standalone_balance + K.account_creation_fee
              if (amount < fee) continue

              withPartner.balance = K.standalone_balance
              amount -= fee
              signer.balance -= fee
              await withPartner.save()
              // now it has id

              /*

              if (me.pubkey.equals(withPartner.pubkey)) {
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
            if (giveTo.id == signer.id) continue
            giveTo.balance += amount
            signer.balance -= amount
            await giveTo.save()
          }
        }

        if (withPartner && withPartner.id) {
          var compared = Buffer.compare(giveTo.pubkey, withPartner.pubkey)
          if (compared == 0) continue

          var ins = (await Insurance.findOrBuild({
            where: {
              leftId: compared == -1 ? giveTo.id : withPartner.id,
              rightId: compared == -1 ? withPartner.id : giveTo.id
            },
            defaults: {
              nonce: 0,
              insurance: 0,
              ondelta: 0
            },
            include: {all: true}
          }))[0]

          ins.insurance += amount
          if (compared == -1) ins.ondelta += amount

          signer.balance -= amount

          if (my_hub) {
            // hubs get reimbursed for rebalancing
            // TODO: attack vector, the user may not endorsed this rebalance
            ins.insurance -= reimburse_tax
            if (compared == 1) ins.ondelta -= reimburse_tax

            // account creation fees are on user, if any
            var diff = readInt(output[0]) - amount
            ins.ondelta -= diff * compared

            signer.balance += reimburse_tax
          }

          await ins.save()

          // rebalance by hub for our account = reimburse hub fees
          /*
          if (my_hub && me.pubkey.equals(withPartner.pubkey)) {
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
        if (me.pubkey.equals(giveTo.pubkey) && output[3].length > 0) {
          var invoice = invoices[toHex(output[3])]
          l('Invoice paid on chain ', output[3])
          if (invoice && invoice.amount <= amount) {
            invoice.status = 'paid'
          }
        }

        parsed_tx.events.push([
          method,
          amount,
          giveTo.id,
          withPartner ? withPartner.id : false,
          output[3].length > 0 ? toHex(output[3]) : false
        ])

        meta.outputs_volume += amount
      }
    } else if (method == 'propose') {
      if (signer.id != 1) {
        l('Only root can propose an amendment')
        break
      }

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
