module.exports = async (global_state, tr, signer, meta) => {
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
      l('Invalid withdrawal sig by partner ', amount, ins)
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

      // already used, nullify
      ch.d.withdrawal_amount = 0
      ch.d.withdrawal_sig = null

      ch.ins = ins

      //if (argv.syncdb) ch.d.save()
    }
  }
}
