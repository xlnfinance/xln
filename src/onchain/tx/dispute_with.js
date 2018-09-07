const deltaStartDispute = async (delta, cheat = false) => {
  if (cheat && delta.CHEAT_profitable_state) {
    var d = [
      delta.partnerId,
      delta.CHEAT_profitable_sig,
      delta.CHEAT_profitable_state
    ]
  } else {
    var d = await deltaGetDispute(delta)
  }
  delta.status = 'disputed'
  me.batchAdd('disputeWith', [delta.asset, d])
  await delta.save()
}

module.exports = async (s, args) => {
  let asset = readInt(args[0])
  // our partner is unresponsive, so we provide dispute proof/state (signed offdelta, nonce, hashlocks etc all in one)
  s.parsed_tx.events.push(['setAsset', 'Dispute', asset])

  for (const dispute of args[1]) {
    const [id, sig, state] = dispute

    const partner = await getUserByIdOrKey(id)
    if (!partner || !partner.id) {
      l('Your partner is not registred')
      await saveId(partner)
    }

    const compared = Buffer.compare(s.signer.pubkey, partner.pubkey)
    if (compared == 0) {
      l('Cannot dispute with yourself')
      return
    }

    const ins = await getInsuranceBetween(s.signer, partner, asset)

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
        !leftId.equals(compared == -1 ? s.signer.pubkey : partner.pubkey) ||
        !rightId.equals(compared == -1 ? partner.pubkey : s.signer.pubkey) ||
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

        s.parsed_tx.events.push([
          'disputeWith',
          partner.id,
          'disputed',
          ins,
          await insuranceResolve(ins)
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

      s.parsed_tx.events.push([
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
        const ch = await me.getChannel(s.signer.pubkey, asset)
        ch.d.status = 'disputed'
        //await ch.d.save()
        const our_nonce = ch.d.signed_state
          ? readInt(r(ch.d.signed_state)[1][2])
          : 0
        //!me.CHEAT_dontack
        if (our_nonce > ins.dispute_nonce && !me.CHEAT_dontack) {
          l('Our last signed nonce is higher! ' + our_nonce)
          await deltaStartDispute(ch.d)
        }
      }
    }
  }
}
