const Router = {
  max_hops: 5,

  getRouteIndex: function(from, to) {
    // returns an index of a bidirectional route (from,to or to,from)
    return K.routes.findIndex((r) => {
      return (r[0] == from && r[1] == to) || (r[0] == to && r[1] == from)
    })
  },

  addRoute: function(from, to) {
    // ensure only unique routes are saved
    if (this.getRouteIndex(from, to) == -1) {
      K.routes.push([from, to])
    }
  },
  removeRoute: function(from, to) {
    // only existing routes can be removed
    let index = this.getRouteIndex(from, to)
    if (index != -1) {
      K.routes.splice(index, 1)
    }
  },
  //https://en.wikipedia.org/wiki/Dijkstra%27s_algorithm
  dijkstra: function(c) {
    // gets context on input
    if (c.targets.includes(c.from)) {
      c.found.push(c.used)
      //return found
    }

    // overflow of hops
    if (c.used.length == this.max_hops) return false

    for (let route of K.routes) {
      let context = Object.assign({}, c)
      if (route[0] == c.from && !c.used.includes(route[1])) {
        context.from = route[1]
        context.used = c.used.concat(context.from)
        this.dijkstra(context)
      } else if (route[1] == c.from && !c.used.includes(route[0])) {
        context.from = route[0]
        context.used = c.used.concat(context.from)
        this.dijkstra(context)
      }
    }
    return c.found
  },

  bestRoutes: function(fromArray, toArray) {
    if (!fromArray || !toArray || fromArray.length == 0 || toArray.length == 0)
      return []

    var found = []

    for (let from of fromArray) {
      this.dijkstra({
        from: from,
        targets: toArray,
        used: [from],
        found: found
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
}

module.exports = Router
