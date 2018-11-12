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
  } else {
    l('Invalid auth attempt')
    return false
  }
}
