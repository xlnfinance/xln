
module.exports = {
  processTx: async function processTx (tx, meta) {
    // l('new ', r(tx, true))

    var [id, sig, methodId, args] = r(tx)
    methodId = readInt(methodId)

    var signer = await User.findById(readInt(id))

    if (!signer) { return {error: "This user doesn't exist"} }

    // we prepend omitted vars to not bloat tx size
    var payload = r([signer.nonce, methodId, args])

    if (!ec.verify(payload, sig, signer.pubkey)) { return {error: 'Invalid signature'} }

    var method = methodMap(methodId)

    if (allowedOnchain.indexOf(method) == -1) { return {error: 'No such method exposed onchain'} }

    var tax = Math.round(K.tax * tx.length)

    if (signer.balance < tax) { return {error: 'Not enough balance to cover tx fee'} }

    // This is precommit, so no need to apply tx and change db
    if (meta.dry_run) {
      if (meta[signer.id]) {
        return {error: 'Only one tx per block per account currently allowed'}
      } else {
        meta[signer.id] = true
        return {success: true}
      }
    }

    l(`ProcessTx: ${method} with ${args.length} by ${signer.id}`)

    // Validation is over, fee is ours. Can be reimbursed by outputs.
    signer.balance -= tax
    K.collected_tax += tax

    args = r(args)

    switch (method) {
      case 'propose':
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
      // don't forget BREAK
      // we use fall-through for methods covered by same code

      case 'dispute':
        var [pubkey, sig, body] = args

        var partner = await User.idOrKey(pubkey)
        if (!partner.id) return l("Your partner is not registred")

        var compared = Buffer.compare(signer.pubkey, partner.pubkey)
        if (compared == 0) return l("Cannot dispute with yourself")

        var ins = (await Insurance.findOrBuild({
          where: {
            leftId: compared==-1?signer.id:partner.id,
            rightId: compared==-1?partner.id:signer.id
          },
          defaults: {
            nonce: 0,
            insurance: 0,
            ondelta: 0
          },
          include: { all: true }
        }))[0]

        if (sig) {
          var parsed = r(body)
          var nonce = readInt(parsed[3])
          var offdelta = readInt(parsed[4])

          var state = r([
            methodMap('offdelta'),
            ins.leftId,
            ins.rightId,
            nonce,
            offdelta
          ])

          if (!ec.verify(state, sig, partner.pubkey)) {
            return l("Invalid offdelta state sig")
          }          
        } else {
          l('Split with default values')
          var nonce = 0
          var offdelta = 0
        }

        var resolved = resolveChannel(ins.insurance, ins.ondelta + offdelta, compared==-1)

        l("Channel result: ", resolved)
        l("Pay out right now ", resolved.they_insured)

        ins.dispute_offdelta == offdelta
        ins.dispute_nonce == nonce

        ins.dispute_left = compared == -1
        ins.dispute_delayed == K.usable_blocks + 4

        await ins.save()

        if (partner.pubkey == me.pubkey) {
          l("Channel with us is closed")
          var ch = await me.channel(signer.pubkey)

          if (resolved.they_insured < ch.insured || resolved.they_promised > ch.promised) {
            l("Stealing attempt")

          }
        }

        break

      case 'rebalance':
        // 1. collect all ins insurance
        var [asset, inputs, outputs] = args
     
        var is_hub = Members.find(m=>m.hub && m.id == signer.id)

        var parsed = {
          inputs: [],
          outputs: [],
          signer: signer.id
        }

        for (var input of inputs) {
          var amount = readInt(input[0])

          var partner = await User.idOrKey(input[1])

          var compared = Buffer.compare(signer.pubkey, partner.pubkey)
          if (compared == 0) continue

          var ins = await Insurance.find({
            where: {
              leftId: compared==-1 ? signer.id : partner.id, 
              rightId: compared==-1 ? partner.id : signer.id
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
            l('Wrong signature by partner')
            continue
          }
          
          // for blockchain explorer
          parsed.inputs.push([amount, partner.id])
          meta.inputs_volume += amount

          ins.insurance -= amount
          if (compared == 1) ins.ondelta += amount

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
              ch.d.our_input_amount = 0
              ch.d.our_input_sig = null
              await ch.d.save()
            }
          }

        }

        // 2. are there disputes?

        // 3. pay to outputs

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
                l("Looks like hub rebalance")

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
                leftId: compared==-1 ? giveTo.id : withPartner.id, 
                rightId: compared==-1 ? withPartner.id : giveTo.id
              },
              defaults: {
                nonce: 0,
                insurance: 0,
                ondelta: 0
              },
              include: {all: true}
            }))[0]

            ins.insurance += amount
            if (compared==1) ins.ondelta -= amount

            signer.balance -= amount

            if (is_hub) {
              ins.insurance -= reimburse_tax
              if (compared==-1) ins.ondelta += reimburse_tax

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

          parsed.outputs.push([amount, giveTo.id, withPartner ? withPartner.id : false])
          meta.outputs_volume += amount
        }

        meta['parsed'].push(parsed)


        break

      case 'voteApprove':
      case 'voteDeny':
        var [proposalId, rationale] = args
        var vote = await Vote.findOrBuild({
          where: {
            userId: signer.id,
            proposalId: readInt(proposalId)
          }
        })
        vote = vote[0]

        vote.rationale = rationale.toString()
        vote.approval = method == 'voteApprove'

        await vote.save()
        l(`Voted ${vote.approval} for ${vote.proposalId}`)

        break
    }

    signer.nonce++

    await signer.save()

    return {success: true}
  },

  mint: async function mint (asset, userId, hubId, amount) {
    var ins = (await Insurance.findOrBuild({
      where: {
        userId: userId,
        hubId: hubId,
        asset: 0
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
