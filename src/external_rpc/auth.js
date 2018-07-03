module.exports = async (ws, args) => {
  let [pubkey, sig, body] = args

  if (ec.verify(r([methodMap('auth')]), sig, pubkey)) {
    //if (pubkey.equals(me.pubkey)) return false

    // wrap in custom WebSocketClient if it is a raw ws object
    if (ws.instance) {
      me.users[pubkey] = ws
    } else {
      me.users[pubkey] = new WebSocketClient()
      me.users[pubkey].instance = ws
    }

    /*if (me.my_hub) {
      let ch = await me.getChannel(pubkey, 1)
      ch.d.last_online = new Date()

      // testnet: instead of cloud backups hub shares latest state
      //me.send(pubkey, 'ack', me.envelope(0, ec(ch.state, me.id.secretKey)))

      if (ch.withdrawal_requested_at) {
        me.send(pubkey, 'requestWithdrawFrom', me.envelope(ch.insured))
      }
      await ch.d.save()
    }*/
  } else {
    l('Invalid auth attempt')
    return false
  }
}
