module.exports = () => {
  //me.intervals.map(clearInterval)

  if (me.external_wss_server) {
    me.external_wss_server.close()
    me.external_wss.clients.forEach((c) => c.close())
    // Object.keys(me.users).forEach( c=>me.users[c].end() )
  }

  me = new Me()

  fatal(1)

  return {pubkey: null}
}
