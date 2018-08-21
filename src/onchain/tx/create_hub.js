const Router = require('../../router')

module.exports = async (s, args) => {
  let json = parse(args[0].toString())

  let hub

  if (!json.handle) return false

  hub = K.hubs.find((h) => h.handle == json.handle)

  // trying to modify someone else's hub
  if (hub && hub.id != s.signer.id) return false

  if (!hub) {
    // create new hub
    hub = {
      id: s.signer.id,
      location: json.location,
      pubkey: toHex(s.signer.pubkey),

      website: json.website,
      // basis points
      fee_bps: parseInt(json.fee_bps),

      handle: json.handle,
      name: json.handle
    }

    K.hubs.push(hub)
  }

  if (json.add_routes) {
    json.add_routes.map((r) => {
      Router.addRoute(hub.id, parseInt(r))
    })
  }

  if (json.remove_routes) {
    json.remove_routes.map((r) => {
      Router.removeRoute(hub.id, parseInt(r))
    })
  }

  if (me.record && me.record.id == s.signer.id) {
    // we just started our own hub
    me.my_hub = hub
  }

  s.parsed_tx.events.push(['createHub', json.handle])
}
