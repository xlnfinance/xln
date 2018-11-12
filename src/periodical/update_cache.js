const isHeadless = () => {
  return me.browsers.length == 0 // || me.browser.readyState != 1
}

module.exports = async (force = false) => {
  if (!me.my_validator && isHeadless() && !force) return

  if (K) {
    cached_result.my_hub = me.my_hub

    cached_result.my_validator = me.my_validator

    cached_result.K = K

    cached_result.busyPorts = Object.keys(me.busyPorts).length

    cached_result.nextValidator = nextValidator()

    await Promise.all(
      [
        async () => {
          cached_result.proposals = await Proposal.findAll({
            order: [['id', 'DESC']],
            include: {all: true}
          })
        },
        async () => {
          cached_result.users = await User.findAll({include: {all: true}})
        },
        async () => {
          cached_result.insurances = await Insurance.findAll({
            include: {all: true}
          })
        },
        async () => {
          for (var hub of cached_result.K.hubs) {
            hub.sumForUser = await getInsuranceSumForUser(hub.id)
          }
        },
        async () => {
          cached_result.hashlocks = await Hashlock.findAll()
        },
        async () => {
          cached_result.assets = await Asset.findAll()
        },
        async () => {
          cached_result.orders = await Order.findAll()
        },
        async () => {
          cached_result.blocks = (await Block.findAll({
            limit: 50,
            order: [['id', 'desc']],
            where: me.show_empty_blocks
              ? {}
              : {
                  meta: {[Op.ne]: null}
                }
          })).map((b) => {
            var [
              methodId,
              built_by,
              total_blocks,
              prev_hash,
              timestamp,
              tx_root,
              db_hash
            ] = r(b.header)

            return {
              id: b.id,
              prev_hash: toHex(b.prev_hash),
              hash: toHex(b.hash),
              built_by: readInt(built_by),
              timestamp: readInt(timestamp),
              meta: JSON.parse(b.meta),
              total_tx: b.total_tx
            }
          })
          return true
        }
      ].map((d) => d())
    )
  }
}
