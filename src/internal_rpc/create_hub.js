module.exports = (args) => {
  //let amount = parseInt(args.amount)

  let json = args

  json.fee_bps = parseInt(json.fee_bps)

  json.add_routes = json.add_routes.split(',').map(parseInt)

  l('create hub json ', json)

  me.batch.push(['createHub', [stringify(json)]])
}
