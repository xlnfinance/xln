module.exports = async (s, args) => {
  // deposit from our onchain balance to another onchain balance or channel from some side
  let asset = readInt(args[0])

  s.parsed_tx.events.push(['setAsset', 'Deposit', asset])

  await userPayDebts(s.signer, asset, s.parsed_tx)

  // there's a tiny bias here, the hub always gets reimbursed more than fee paid
  // todo: consider splitting txfee based on % in total output volume
  // const reimburse_txfee = 1 + Math.floor(s.parsed_tx.txfee / args.length)

  for (let output of args[1]) {
    let amount = readInt(output[0])
    let original_amount = amount

    let signer_has = userAsset(s.signer, asset)

    if (amount > signer_has) {
      l(`${s.signer.id} Trying to deposit ${amount} but has ${signer_has}`)
      return
    }

    const depositTo = await getUserByIdOrKey(output[1])
    if (!depositTo) return

    const withPartner =
      output[2].length == 0 ? false : await getUserByIdOrKey(output[2])

    // here we ensure both parties are registred (have id), and take needed fees
    if (!depositTo.id) {
      // you must be registered first using asset 1
      if (asset != 1) {
        l('Not 1 asset')
        return
      }

      if (!withPartner) {
        if (amount < K.account_creation_fee) return

        userAsset(depositTo, asset, amount - K.account_creation_fee)
        userAsset(s.signer, asset, -amount)
      } else {
        if (!withPartner.id) {
          l("Both partners don't exist")
          return
        }

        throw 'yolo'

        const fee = K.standalone_balance + K.account_creation_fee
        if (amount < fee) return

        userAsset(depositTo, asset, K.standalone_balance)
        amount -= fee
        //userAsset(s.signer, asset, -fee)
      }

      await saveId(depositTo)

      K.collected_fees += K.account_creation_fee
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

          userAsset(withPartner, asset, K.standalone_balance)
          amount -= fee
          //userAsset(signer, asset, -fee)
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
        if (depositTo.id == s.signer.id) {
          l('Trying to deposit to your onchain balance is pointless')
          return
        }
        userAsset(depositTo, asset, amount)
        userAsset(s.signer, asset, -amount)
        await saveId(depositTo)
      }
    }

    if (withPartner && withPartner.id) {
      const compared = Buffer.compare(depositTo.pubkey, withPartner.pubkey)
      if (compared == 0) return

      const ins = await getInsuranceBetween(depositTo, withPartner, asset)

      ins.insurance += amount
      if (depositTo.id == ins.leftId) ins.ondelta += amount

      // user is paying themselves for registration
      const regfees = original_amount - amount
      ins.ondelta -= compared * regfees

      userAsset(s.signer, asset, -amount)

      if (K.hubs.find((h) => h.id == s.signer.id)) {
        // The hub gets reimbursed for rebalancing users.
        // Otherwise it would be harder to collect fee from participants
        // TODO: attack vector, the user may not endorsed this rebalance
        // reimbures to hub rebalance fees
        /*
        ins.insurance -= reimburse_txfee
        ins.ondelta -= compared * reimburse_txfee
        userAsset(s.signer, 1, reimburse_txfee)
        */
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
          -reimburse_txfee,
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

    s.parsed_tx.events.push([
      'depositTo',
      amount,
      depositTo.id,
      withPartner ? withPartner.id : false,
      invoice ? toHex(invoice) : false
    ])

    s.meta.outputs_volume += amount
  }
}
