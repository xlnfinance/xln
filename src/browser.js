// This file has browser-related helpers that cache and react into me.browser socket.

// Called once in a while to cache current state of everything and flush it to browser
// TODO: better way to keep app reactive?
cache = async (force = false) => {
  if (!me.my_member && me.headless() && !force) return

  if (K) {
    cached_result.my_hub = me.my_hub

    cached_result.my_member = !!me.my_member

    cached_result.K = K

    cached_result.current_db_hash = current_db_hash().toString('hex')

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
          cached_result.insurances = await Insurance.findAll()
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
            limit: 100,
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

// Flush an object to browser websocket. Send force=false for lazy react (for high-tps nodes like hubs)
react = async (result = {}, force = true) => {
  // hubs dont react OR no alive browser socket
  if (me.my_hub && !force) {
    return //l('No working me.browser')
  }

  if (new Date() - me.last_react < 500) {
    //l('reacting too often is bad for performance')
    //return false
  }
  me.last_react = new Date()

  if (!me.my_hub) {
    await me.syncdb()
  }

  if (me.headless()) return

  //await cache()

  if (me.id) {
    if (me.my_hub) {
      /*
      var deltas = await Delta.findAll({where: {myId: me.record.id}})
      var they_uninsured = 0
      for (var d of deltas) {
        var ch = await me.getChannel(d.userId, d.asset)
        if (ch.they_uninsured > 0) they_uninsured += ch.they_uninsured
      }

      if (
        cached_result.history[0] &&
        cached_result.history[0].they_uninsured != they_uninsured
      ) {
        cached_result.history.unshift({
          date: new Date(),
          they_uninsured: they_uninsured
        })
      }
      */
    }

    ;[result.payments, result.channels, result.record] = await Promise.all([
      Payment.findAll({
        order: [['id', 'desc']],
        //include: {all: true},
        limit: 300
      }),
      me.channels(),
      me.byKey()
    ])

    /*
    var offered_partners = (await me.channels())
      .sort((a, b) => b.they_payable - a.they_payable)
      .filter((a) => a.they_payable >= amount)
      .map((a) => a.partner)
      .join('_')
      */
    result.address = me.address
    result.pubkey = toHex(me.pubkey)
    result.pending_batch = PK.pending_batch
  }

  if (me.headless()) return

  try {
    me.browser.send(
      JSON.stringify({
        result: Object.assign(result, cached_result)
      })
    )
  } catch (e) {
    l(e)
  }
}

// Eats memory. Do it only at bootstrap or after generating a new snapshot
snapshotHash = async () => {
  if (me.my_member && K.last_snapshot_height) {
    var filename = `Failsafe-${K.last_snapshot_height}.tar.gz`
    var cmd = `shasum -a 256 ${datadir}/offchain/${filename}`

    require('child_process').exec(cmd, async (er, out, err) => {
      if (out.length == 0) {
        l('This state doesnt exist')
        return false
      }

      var out_hash = out.split(' ')[0]

      var our_location =
        me.my_member.location.indexOf(localhost) != -1
          ? `http://${localhost}:8000/`
          : `https://failsafe.network/`

      cached_result.install_snippet = `id=fs
f=${filename}
mkdir $id && cd $id && curl ${our_location}$f -o $f
if [[ -x /usr/bin/sha256sum ]] && sha256sum $f || shasum -a 256 $f | grep \\
  ${out_hash}; then
  tar -xzf $f && rm $f && ./install
  node fs -p8001
fi
`
    })
  }
}

// TODO: Move from memory to persistent DB
cached_result = {
  history: [],
  my_log: '',
  settle_tps: 0
}
