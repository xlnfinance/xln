module.exports = async (s, args) => {
  // withdraw money from a channel by providing a sig of your partner
  // you can only withdraw from insured balance
  let asset = readInt(args[0])
  s.parsed_tx.events.push(['setAsset', 'Withdraw', asset])

  for (const withdrawal of args[1]) {
    // how much? with who? their signature
    let [amount, partnerId, withdrawal_sig] = withdrawal

    amount = readInt(amount)

    const partner = await getUserByIdOrKey(partnerId)
    if (!partner || !partner.id) {
      l('Cant withdraw from nonexistent partner')
      return
    }

    const compared = Buffer.compare(s.signer.pubkey, partner.pubkey)
    if (compared == 0) return

    const ins = await getInsuranceBetween(s.signer, partner)
    let subins = ins.subinsurances.by('asset', asset)

    if (!ins || !ins.id || amount > subins.balance) {
      l(`Invalid amount ${subins.balance} vs ${amount}`)
      return
    }

    const body = r([
      methodMap('withdrawFrom'),
      ins.leftId,
      ins.rightId,
      ins.withdrawal_nonce,
      amount,
      asset
    ])

    if (!ec.verify(body, withdrawal_sig, partner.pubkey)) {
      l(
        'Invalid withdrawal sig by partner ',
        asset,
        ins.withdrawal_nonce,
        amount,
        withdrawal_sig,
        partner.pubkey
      )
      return
    }

    // for blockchain explorer
    s.parsed_tx.events.push(['withdrawFrom', amount, partner.id])
    s.meta.inputs_volume += amount // todo: asset-specific

    subins.balance -= amount
    // if signer is left and reduces insurance, move ondelta to the left too
    // .====| reduce insurance .==--| reduce ondelta .==|
    if (s.signer.id == ins.leftId) subins.ondelta -= amount

    userAsset(s.signer, asset, amount)

    // preventing double spend with same withdrawal
    ins.withdrawal_nonce++

    await saveId(ins)

    // was this input related to us?
    if (me.record && [partner.id, s.signer.id].includes(me.record.id)) {
      const ch = await Channel.get(
        me.record.id == partner.id ? s.signer.pubkey : partner.pubkey
      )
      let subch = ch.d.subchannels.by('asset', asset)
      // they planned to withdraw and they did. Nullify hold amount
      subch.they_withdrawal_amount = 0

      // already used, nullify
      subch.withdrawal_amount = 0
      subch.withdrawal_sig = null

      ch.ins = ins

      //if (argv.syncdb) ch.d.save()
    }
  }
}
