
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

      case 'dispute':
        var [pubkey, sig, body] = args

        var ch = await Insurance.findOrBuild({
          where: {
            userId: user.id,
            hubId: 1
          },
          defaults: {
            nonce: 0,
            insurance: 0,
            ondelta: 0
          },
          include: { all: true }
        })


      break

      case 'rebalanceHub':
      case 'rebalanceUser':
        // 1. collect all ins insurance
        var [asset, inputs, outputs] = args

        var is_hub = (method == 'rebalanceHub')

        l("Processing inputs ", inputs)

        for (var input of inputs) {
          var amount = readInt(input[0])
          var userId = readInt(input[1]) // no pubkey ID is allowed here 
          var sig = input[2]

          var ins = await Insurance.find({
            where: is_hub ? {userId: userId, hubId: signer.id} : {userId: signer.id, hubId: userId},
            include: {all: true}
          })

          var body = r([methodMap('withdrawal'),
            ins.userId,
            ins.hubId,
            ins.nonce,
            amount
          ])

          var partner = await User.findById(userId)

          if (!ec.verify(body, sig, partner.pubkey)) {
            l("Fake signature by partner")
            continue
          }

          if (amount > ins.insurance) {
            l(`Invalid amount ${ins.insurance} vs ${amount}`)
            continue
          }


          ins.insurance -= amount
          signer.balance += amount
          if (is_hub) ins.ondelta += amount

          ins.nonce++

          await ins.save()

          // was this input related to us?
          if (me.record) {

            if (me.record.id == userId) {
              var ch = await me.channel(signer.pubkey)
              // they planned to withdraw and they did. Nullify hold amount
              ch.d.their_input_amount = 0
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
        var reimbursed = 0
        var reimburse_tax = 1 + Math.floor(tax / outputs.length)

        for (var d of outputs) {
          var originalAmount = readInt(d[0])
          var amount = readInt(d[0])

          l('outputs ', amount, originalAmount)
          var userId = d[1]

          var hubId = readInt(d[2])

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

          var is_me = me.id && me.pubkey.equals(user.pubkey)


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
                hubId: hubId
              },
              defaults: {
                nonce: 0,
                insurance: 0,
                ondelta: 0
              },
              include: { all: true }
            })

            ch[0].insurance += amount

            if (is_hub) {
              ch[0].insurance -= reimburse_tax
              reimbursed += reimburse_tax

              ch[0].ondelta -= originalAmount

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

    signer.nonce++

    await signer.save()

    return {success: true}
  },

  mint: async function mint (asset, userId, hubId, amount) {
    var ch = (await Insurance.findOrBuild({
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

    ch.insurance += amount
    K.assets[asset].total_supply += amount

    await ch.save()
  }
}
