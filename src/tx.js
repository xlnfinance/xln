// supported types of transactions. Mainly about rebalance and self-amendments

module.exports = {
  processTx: async function processTx (tx, meta) {
    var [id, sig, methodId, nonce, args] = r(tx)

    var signer = await User.findById(readInt(id))
    var nonce = readInt(nonce)

    if (!signer) { return {error: "This user doesn't exist"} }

    if (!ec.verify(r([readInt(methodId), nonce, args]), sig, signer.pubkey)) {
      return {error: `Invalid tx signature.`}
    }

    var method = methodMap(readInt(methodId))

    if (allowedOnchain.indexOf(method) == -1) {
      return {error: 'No such method exposed onchain'}
    }

    var tax = Math.round(K.tax * tx.length)

    if (signer.balance < tax) { return {error: 'Not enough balance to cover tx fee'} }

    // This is precommit, so no need to apply tx and change db
    if (meta.dry_run) {
      if (meta[signer.id] && meta[signer.id] > 5) {
        return {error: 'Only few tx per block per account currently allowed'}
      } else {
        if (!meta[signer.id]) meta[signer.id] = 0

        if (signer.nonce + meta[signer.id] != nonce) {
          //return {error: 'Invalid nonce dry run'}
        }

        meta[signer.id]++

        return {success: true}
      }
    } else {
      if (signer.nonce != nonce) {
        return {error: 'Invalid nonce'}
      }      
    }

    l(`ProcessTx: ${method} with ${args.length} by ${signer.id}`)


    if (me.pubkey.equals(signer.pubkey)) {
      for (var i in PK.pending_tx) {
        if (PK.pending_tx[i].raw == toHex(tx)) {
          l("Our pending tx has been added to the blockchain")
          PK.pending_tx.splice(i, 1)
        }
      }
    }

    // Validation is over, fee is validator's
    signer.balance -= tax
    K.collected_tax += tax

    args = r(args)

    var parsed_tx = {
      method: method,
      signer: signer,
      nonce: nonce,
      tax: tax,
      length: tx.length
    }

    // don't forget BREAK
    switch (method) {
      case 'rebalance':
        var [disputes, inputs, outputs] = args

        parsed_tx.disputes = []
        parsed_tx.inputs = []
        parsed_tx.debts = []
        parsed_tx.outputs = []

        // 1. process disputes if any

        for (let dispute of disputes) {
          var [id, sig, dispute_nonce, offdelta, hashlocks] = dispute

          var partner = await User.findById(readInt(id))
          if (!partner) return l('Your partner is not registred')

          var compared = Buffer.compare(signer.pubkey, partner.pubkey)
          if (compared == 0) return l('Cannot dispute with yourself')

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
            include: { all: true }
          }))[0]

          if (sig) {
            var dispute_nonce = readInt(dispute_nonce)
            var offdelta = readInt(offdelta) // SIGNED int

            var state = r([
              methodMap('dispute'),
              compared == -1 ? signer.pubkey : partner.pubkey,
              compared == -1 ? partner.pubkey : signer.pubkey,
              dispute_nonce,
              offdelta,
              hashlocks
            ])

            if (!ec.verify(state, sig, partner.pubkey)) {
              return l('Invalid offdelta state sig ', state)
            }
          } else {
            l('New channel? Split with default values')
            var dispute_nonce = 0
            var offdelta = 0
          }

          var offer = resolveChannel(ins.insurance, ins.ondelta + offdelta)

          if (ins.dispute_delayed) {
            if (dispute_nonce > ins.dispute_nonce && ins.dispute_left == (compared == 1)) {

              parsed_tx.disputes.push([partner.id, 'disputed', ins, offer])

              ins.dispute_offdelta = offdelta
              await ins.resolve()
              l("Resolving with fraud proof")
            } else {
              l('Old nonce or same counterparty')
            }
          } else {
            // TODO: return to partner their part right away, and our part is delayed
            ins.dispute_offdelta = offdelta
            ins.dispute_nonce = dispute_nonce

            ins.dispute_left = (compared == -1)
            ins.dispute_delayed = K.usable_blocks + 9

            parsed_tx.disputes.push([partner.id, 'started', ins, offer])

            await ins.save()


            if (me.pubkey.equals(partner.pubkey)) {
              l('Channel with us is disputed')
              var ch = await me.channel(signer.pubkey)
              ch.d.status = 'disputed'
              await ch.d.save()

              if ((ch.left && offdelta < ch.d.offdelta) ||
                (!ch.left && offdelta > ch.d.offdelta)) {
                l('Unprofitable proof posted!')
                await ch.d.startDispute()
              }
            }
          }
        }




        // 2. take insurance from withdrawals

        var is_hub = Members.find(m => m.hub && m.id == signer.id)


        for (var input of inputs) {
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

          var body = r([methodMap('withdrawal'),
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
          parsed_tx.inputs.push([amount, partner.id])
          meta.inputs_volume += amount

          ins.insurance -= amount
          if (compared == -1) ins.ondelta -= amount

          signer.balance += amount

          ins.nonce++

          await ins.save()

          // was this input related to us?
          if (me.record) {
            if (me.record.id == partner.id) {
              var ch = await me.channel(signer.pubkey)
              // they planned to withdraw and they did. Nullify hold amount
              ch.d.they_input_amount = 0
              await ch.d.save()
            }

            if (me.record.id == signer.id) {
              var ch = await me.channel(partner.pubkey)
              // they planned to withdraw and they did. Nullify hold amount
              ch.d.input_amount = 0
              ch.d.input_sig = null
              await ch.d.save()
            }
          }
        }

        // 3. enforce pay insurance to debts
        await signer.payDebts(parsed_tx)


        // 4. outputs: standalone balance or a channel

        // we want outputs to pay for their own rebalance
        var reimburse_tax = 1 + Math.floor(tax / outputs.length)

        for (var output of outputs) {
          amount = readInt(output[0])

          if (amount > signer.balance) continue

          var giveTo = await User.idOrKey(output[1])
          var withPartner = output[2].length == 0 ? false : await User.idOrKey(output[2])

          // here we ensure both parties are registred, and take needed fees

          if (!giveTo.id) {
            if (!withPartner) {
              if (amount < K.account_creation_fee) continue
              giveTo.balance = (amount - K.account_creation_fee)

              signer.balance -= amount
            } else {
              if (!withPartner.id) continue

              var fee = (K.standalone_balance + K.account_creation_fee)
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

                var fee = (K.standalone_balance + K.account_creation_fee)
                if (amount < fee) continue

                withPartner.balance = K.standalone_balance
                amount -= fee
                signer.balance -= fee
                await withPartner.save()
                // now it has id

                if (me.pubkey.equals(withPartner.pubkey)) {
                  await me.addHistory(giveTo.pubkey, -K.account_creation_fee, 'Account creation fee')
                  await me.addHistory(giveTo.pubkey, -K.standalone_balance, 'Minimum global balance')
                }
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

            if (is_hub) {
              // hubs get reimbursed for rebalancing
              // TODO: attack vector, the user may not endorsed this rebalance
              ins.insurance -= reimburse_tax
              if (compared == 1) ins.ondelta -= reimburse_tax

              // account creation fees are on user, if any
              var diff = (readInt(output[0]) - amount)
              ins.ondelta -= diff * compared

              signer.balance += reimburse_tax
            }

            await ins.save()

            // rebalance by hub for our account = reimburse hub fees
            if (is_hub && me.pubkey.equals(withPartner.pubkey)) {
              await me.addHistory(giveTo.pubkey, -reimburse_tax, 'Rebalance fee', true)
            }
          }

          // on-chain payment for specific invoice (to us or one of our channels)
          if (me.pubkey.equals(giveTo.pubkey) && output[3].length > 0) {
            var invoice = invoices[toHex(output[3])]
            l("Invoice paid on chain ", output[3])
            if (invoice && invoice.amount <= amount) {
              invoice.status = 'paid'
            }
          }

          parsed_tx.outputs.push([amount, 
            giveTo.id, 
            withPartner ? withPartner.id : false, 
            output[3].length > 0 ? toHex(output[3]) : false])

          meta.outputs_volume += amount
        }


        break






      case 'propose':
        if (signer.id != 1) return l("Currenlty only root can propose an amendment")

        var execute_on = K.usable_blocks + K.voting_period // 60*24

        var new_proposal = await Proposal.create({
          desc: args[0].toString(),
          code: args[1].toString(),
          patch: args[2].toString(),
          kindof: method,
          delayed: execute_on,
          userId: signer.id
        })

        l(`Added new proposal!`)
        K.proposals_created++
        break

      case 'vote':
        var [proposalId, approval, rationale] = args
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
        l(`Voted ${vote.approval} for ${vote.proposalId}`)

        break
    }

    signer.nonce++
    
    meta['parsed_tx'].push(parsed_tx)

    await signer.save()

    return {success: true}
  },





  mint: async function mint (asset, leftId, rightId, amount) {
    var ins = (await Insurance.findOrBuild({
      where: {
        leftId: leftId,
        rightId: rightId,
        asset: asset
      },
      defaults: {
        nonce: 0,
        insurance: 0,
        ondelta: 0
      },
      include: { all: true }
    }))[0]

    ins.insurance += amount

    K.assets[asset].total_supply += amount

    await ins.save()
  }
}
