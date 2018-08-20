const Router = require('../router')

module.exports = (args) => {
  let addr = parseAddress(args.address)

  l(args.address, PK.usedHubs, addr)

  return {
    bestRoutes: Router.bestRoutes(PK.usedHubs, addr.hubs)
  }
}
