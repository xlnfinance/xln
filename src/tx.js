
module.exports = {
  processTx: async function processTx (tx, pseudo_balances) {
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
    if (pseudo_balances) {
      if (pseudo_balances[signer.id]) {
        return {error: 'Only one tx per block per account currently allowed'}
      } else {
        pseudo_balances[signer.id] = true
        return {success: true}
      }
    }

    l(`ProcessTx: ${method} with ${args.length} by ${id}`)

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

      case 'rebalanceHub':
      case 'rebalanceUser':
        // 1. collect all ins insurance
        var [assetType, inputs, outputs] = args

        var is_hub = (method == 'rebalanceHub')

        for (let input of inputs) {
          if (input.length == 1) {
            // var pubkey = input
            var no_delta = true
          } else {
            var no_delta = false
            l(input)
            var [pubkey, sig, body] = r(input)
          }

          l(body, sig, pubkey)

          if (no_delta || ec.verify(body, sig, pubkey)) {
            var [counterparty, nonce, delta, instant_until] = no_delta ? [signer.pubkey, 0, 0, 0] : me.parseDelta(body)

            var ch = await Insurance.find({
              where: {
                userId: is_hub ? (await me.byKey(pubkey)).id : signer.id,
                hubId: 1,
                assetType: 0
              },
              include: {all: true}
            })

            if (instant_until + 1000 < K.ts) {
              // not instant? start dispute

              ch.delayed = K.usable_blocks + K.dispute_delay
              ch.dispute_delta = delta
              ch.dispute_is_hub = is_hub
            } else {
              if (is_hub) {
                // inverse delta to amount
                var amount = -(ch.rebalanced + delta)
                if (readInt(counterparty) != 1) { l('Wrong hub'); continue }

                // if(nonce < ch.nonce){l("Wrong nonce"); continue}
                if (amount <= 0) { l('Must be over 0'); continue }
                if (ch.insurance < amount) {
                  // we don't allow users to pay below insurance yet
                  l(`Invalid amount ${ch.insurance} vs ${amount}`)
                  continue
                }

                ch.rebalanced += amount
              } else {
                var amount = ch.insurance + ch.rebalanced + delta
                l(ch.insurance, ch.rebalanced, delta)
                l(counterparty, signer.pubkey)

                if (!signer.pubkey.equals(counterparty)) { l('Wrong counterparty of delta proof'); continue }

                if (amount <= 0) { l('Must be over 0'); continue }

                if (ch.insurance < amount) {
                  amount = ch.insurance
                  // the rest goes to debt
                }
              }

              ch.insurance -= amount

              // adding input to the signer balance first
              signer.balance += amount
            }

            // updating nonce to prevent double spend
            ch.nonce = nonce

            await ch.save()
          }
        }

        // 2. are there disputes?

        // 3. pay to outputs

        // we want outputs to pay for their own rebalance
        var reimbursed = 0
        var reimburse_tax = 1 + Math.floor(tax / outputs.length)

        for (var i = 0; i < outputs.length; i++) {
          var [userId, hubId, amount] = outputs[i]

          var originalAmount = readInt(amount)
          amount = readInt(amount)

          l('outputs ', amount, originalAmount)

          hubId = readInt(hubId)

          // is pubkey or id
          // if(userId.length != 32) userId = readInt(userId)

          if (amount > signer.balance) continue

          if (userId.length == 32) {
            var user = await User.findOrBuild({
              where: {pubkey: userId},
              defaults: {
                nonce: 0
              }
            })
            user = user[0]
          } else {
            var user = await User.findById(readInt(userId))
          }

          var is_me = me.id && me.id.publicKey.equals(user.pubkey)


          if (user.id) {
            if (hubId == undefined) {
              // can't settle to own global balance
              if (user.id == signer.id) continue

              l('Adding to existing user')
              // already exists
              user.balance += amount
              signer.balance -= amount
            } else {

            }
          } else {
            l('Created new user')

            if (hubId == undefined) {
              if (amount < K.account_creation_fee) continue
              user.balance = (amount - K.account_creation_fee)

              signer.balance -= amount
            } else {
              var fee = (K.standalone_balance + K.account_creation_fee)
              if (amount < fee) continue

              user.balance = K.standalone_balance
              amount -= fee
              signer.balance -= fee

              if (is_me) {
                await me.addHistory(-K.account_creation_fee, 'Account creation fee')
                await me.addHistory(-K.standalone_balance, 'Minimum global balance')
              }

            }

            K.collected_tax += K.account_creation_fee
          }

          await user.save()

          if (hubId) {
            var ch = await Insurance.findOrBuild({
              where: {
                userId: user.id,
                hubId: hubId,
                assetType: 0
              },
              defaults: {
                nonce: 0,
                insurance: 0,
                rebalanced: 0
              },
              include: { all: true }
            })

            ch[0].insurance += amount

            if (is_hub) {
              ch[0].insurance -= reimburse_tax
              reimbursed += reimburse_tax

              ch[0].rebalanced -= originalAmount

            }
            signer.balance -= amount

            await ch[0].save()


            // rebalance by hub for our account = reimburse hub fees
            if (is_hub && is_me) {
              await me.addHistory(-reimburse_tax, 'Rebalance fee', true)
            }
          }


        }

        signer.balance += reimbursed

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

    signer.nonce += 1

    await signer.save()

    return {success: true}
  },

  mint: async function mint (assetType, userId, hubId, amount) {
    var ch = (await Insurance.findOrBuild({
      where: {
        userId: userId,
        hubId: hubId,
        assetType: 0
      },
      defaults: {
        nonce: 0,
        insurance: 0,
        rebalanced: 0
      },
      include: { all: true }
    }))[0]

    ch.insurance += amount
    K.assets[assetType].total_supply += amount

    await ch.save()
  }
}
