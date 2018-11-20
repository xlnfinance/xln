module.exports = async (s, args) => {
  // our partner is unresponsive, so we last signed state

  const [id, sig, state] = args

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

  const ins = await getInsuranceBetween(s.signer, partner)

  let dispute_nonce = 0

  if (sig) {
    if (!ec.verify(state, sig, partner.pubkey)) {
      l('Invalid sig ', state)
      return
    }

    // see ch.state= to see how state it's built
    var [methodId, [leftId, rightId, new_dispute_nonce], subchannels] = r(state)

    if (
      methodMap(readInt(methodId)) != 'disputeWith' ||
      !leftId.equals(compared == -1 ? s.signer.pubkey : partner.pubkey) ||
      !rightId.equals(compared == -1 ? partner.pubkey : s.signer.pubkey)
    ) {
      l('Invalid dispute')
      return
    }

    // overwrite the above default "let" params
    dispute_nonce = readInt(new_dispute_nonce)
  } else {
    l('New channel? Split with default values')
  }

  if (ins.dispute_nonce && dispute_nonce <= ins.dispute_nonce) {
    l(`New dispute_nonce in dispute must be higher`)
    return
  }

  if (ins.dispute_delayed) {
    // the other party sends counterproof
    if (ins.dispute_left == (compared == 1)) {
      // TODO: any punishment for cheating for starting party?
      // we don't want to slash everything like in LN, but some fee would help
      ins.dispute_state = r(subchannels)

      ins.dispute_nonce = dispute_nonce
      let output = await insuranceResolve(ins)
      l('Resolved with counter proof')

      s.parsed_tx.events.push([
        'disputeWith',
        partner.id,
        'disputed',
        ins,
        output
      ])
    } else {
      l('Old dispute_nonce or same counterparty')
    }
  } else {
    // TODO: return to partner their part right away, and our part is delayed
    ins.dispute_nonce = dispute_nonce
    ins.dispute_state = r(subchannels)

    ins.dispute_left = compared == -1

    // hubs are always online and react faster
    let delay = K.hubs.find((h) => h.id == partner.id)
      ? K.dispute_delay_for_hubs
      : K.dispute_delay_for_users
    ins.dispute_delayed = K.usable_blocks + delay

    s.parsed_tx.events.push(['disputeWith', partner.id, 'started', ins])

    await saveId(ins)

    if (me.is_me(partner.pubkey)) {
      l('Channel with us is disputed')
      // now our job is to ensure our inward hashlocks are unlocked
      // and that we get most profitable outcome
      const ch = await Channel.get(s.signer.pubkey)
      ch.d.status = 'disputed'
      ch.ins = ins
      //await ch.d.save()
      const our_dispute_nonce = ch.d.signed_state
        ? readInt(r(ch.d.signed_state)[1][2])
        : 0
      //!me.CHEAT_dontack
      if (our_dispute_nonce > ins.dispute_nonce && !me.CHEAT_dontack) {
        l('Our last signed nonce is higher! ' + our_dispute_nonce)
        me.addBatch('disputeWith', await startDispute(ch))
      }
    }
  }
}
