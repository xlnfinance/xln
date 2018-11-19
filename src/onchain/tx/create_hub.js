const Router = require('../../router')

module.exports = async (s, args) => {
  let json = parse(args.toString())

  if (!json.handle) return false

  json.fee_bps = parseInt(json.fee_bps)
  if (json.fee_bps > 500) return false

  let hub = K.hubs.find((h) => h.handle == json.handle)

  // trying to modify someone else's hub
  if (hub && hub.id != s.signer.id) return false

  if (!hub) {
    // create new hub
    hub = {
      id: s.signer.id,
      location: json.location,
      pubkey: toHex(s.signer.pubkey),
      box_pubkey: json.box_pubkey,

      website: json.website,
      // basis points
      fee_bps: json.fee_bps,

      handle: json.handle,
      name: json.handle,

      createdAt: K.ts
    }

    K.hubs.push(hub)

    if (me.record && me.record.id == s.signer.id) {
      // we just started our own hub
      me.my_hub = hub
      Periodical.startHub()
    } else {
      // start trusting new hub automatically
      require('../../internal_rpc/with_channel')({
        op: 'setLimits',
        partnerId: hub.pubkey,
        asset: 1,
        soft_limit: K.soft_limit,
        hard_limit: K.hard_limit
      })
    }
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

  s.parsed_tx.events.push(['createHub', json.handle])
}
