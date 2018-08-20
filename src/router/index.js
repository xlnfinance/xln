const bestRoutes = (fromArray, toArray) => {
  var found = []

  let getRoutes = (c) => {
    // gets context
    if (c.targets.includes(c.from)) {
      c.found.push(c.used)
      //return found
    }

    // overflow of hops
    if (c.used.length == c.max) return false

    for (let route of K.routes) {
      let context = Object.assign({}, c)
      if (route[0] == c.from && !c.used.includes(route[1])) {
        context.from = route[1]
        context.used = c.used.concat(context.from)
        getRoutes(context)
      } else if (route[1] == c.from && !c.used.includes(route[0])) {
        context.from = route[0]
        context.used = c.used.concat(context.from)
        getRoutes(context)
      }
    }
    return c.found
  }

  for (let from of fromArray) {
    getRoutes({
      from: from,
      targets: toArray,
      used: [from],
      found: found,
      max: 4
    })
  }

  // sort by fee
  return found
    .map((route) => {
      var afterfees = 1
      for (let hop of route) {
        let hub = K.hubs.find((h) => h.id == hop)
        if (hub) {
          afterfees *= 1 - hub.fee_bps / 10000
        }
      }

      return [1 - afterfees, route]
    })
    .sort((a, b) => a[0] - b[0])
}

const addRoutes = (from, to) => {
  // ensure only unique routes are saved

  K.routes.push([from, to])
  //for (let )
}

module.exports = {
  addRoutes: addRoutes,
  bestRoutes: bestRoutes
}
