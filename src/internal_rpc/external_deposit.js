module.exports = async (dep) => {
  // split by @
  if (dep.to.length > 0) {
    let to = dep.to
    let userId

    // looks like a pubkey
    if (to.length == 64) {
      userId = Buffer.from(to, 'hex')

      // maybe this pubkey is already registred?
      let u = await getUserByIdOrKey(userId)

      if (u.id) {
        userId = u.id
      }
    } else {
      // looks like numerical ID
      userId = parseInt(to)

      let u = await getUserByIdOrKey(userId)

      if (!u) {
        return {alert: 'User with short ID ' + userId + " doesn't exist."}
      }
    }

    let amount = parseInt(dep.depositAmount)

    let withPartner = 0
    // @onchain or @0 mean onchain balance
    if (dep.hub && dep.hub != 'onchain') {
      // find a hub by its handle or id
      let h = K.hubs.find((h) => h.handle == dep.hub || h.id == dep.hub)
      if (h) {
        withPartner = h.id
      } else {
        react({alert: 'No such hub'})
        return
      }
    }

    if (amount > 0) {
      me.batchAdd('depositTo', [
        dep.asset,
        [
          amount,
          userId,
          withPartner,
          dep.invoice ? Buffer.from(dep.invoice, 'hex') : 0
        ]
      ])
    }
  }
}
