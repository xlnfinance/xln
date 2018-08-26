module.exports = (args) => {
  //let amount = parseInt(args.amount)

  let json = args

  json.fee_bps = parseInt(json.fee_bps)

  json.box_pubkey = toHex(bin(me.box.publicKey))

  if (json.add_routes && json.add_routes.length > 0) {
    json.add_routes = json.add_routes.split(',').map((f) => parseInt(f))
  }
  if (json.remove_routes && json.remove_routes.length > 0) {
    json.remove_routes = json.remove_routes.split(',').map((f) => parseInt(f))
  }
  l('create hub json ', json)

  // starting WSS if not yet started. proactively before we are a hub
  if (!me.external_wss_server) {
    me.startExternalRPC(json.location)

    me.intervals.push(
      setInterval(require('../offchain/rebalance'), K.blocktime * 1000)
    )
  }

  me.batch.push(['createHub', [stringify(json)]])
}
