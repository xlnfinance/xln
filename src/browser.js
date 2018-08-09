// This file has browser-related helpers that cache and react into me.browser socket.

// Called once in a while to cache current state of everything and flush it to browser
// TODO: better way to keep app reactive?

// returns true if no active browser ws now
const isHeadless = () => {
  return !me.browser || me.browser.readyState != 1
}

update_cache = async (force = false) => {
  if (!me.my_validator && isHeadless() && !force) return

  if (K) {
    cached_result.my_hub = me.my_hub

    cached_result.my_validator = me.my_validator

    cached_result.K = K

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
          cached_result.insurances = await Insurance.findAll()
        },
        async () => {
          for (var hub of cached_result.K.hubs) {
            hub.sumForUser = await Insurance.sumForUser(hub.id)
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
    //await syncdb()
  }

  if (isHeadless()) return

  //await update_cache()

  if (me.id) {
    ;[result.payments, result.channels, result.record] = await Promise.all([
      Payment.findAll({
        order: [['id', 'desc']],
        //include: {all: true},
        limit: 300
      }),
      me.channels(),
      User.idOrKey(bin(me.id.publicKey))
    ])

    if (!result.record.id) result.record = null

    result.payments.map((p) => {
      // prefix for invoice types: 1 is user set 2 is random
      if (p.invoice) {
        p.invoice = p.invoice
          .slice(1)
          .toString(p.invoice[0] == 1 ? 'utf8' : 'hex')
      }
    })

    result.address = me.address
    result.pubkey = toHex(me.pubkey)
    result.pending_batch = PK.pending_batch
    result.batch = me.batch
    result.batch_estimate = await me.batch_estimate()
  }

  if (isHeadless()) return

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
  if (me.my_validator && K.last_snapshot_height) {
    var filename = `Fair-${K.last_snapshot_height}.tar.gz`
    var cmd = `shasum -a 256 ${datadir}/offchain/${filename}`

    require('child_process').exec(cmd, async (er, out, err) => {
      if (out.length == 0) {
        l('This state doesnt exist')
        return false
      }

      var out_hash = out.split(' ')[0]

      var our_location =
        me.my_validator.location.indexOf(localhost) != -1
          ? `http://${localhost}:8001/`
          : `https://fairlayer.com/`

      cached_result.install_snippet = `id=fair
f=${filename}
mkdir $id && cd $id && curl ${our_location}$f -o $f
if [[ -x /usr/bin/sha256sum ]] && sha256sum $f || shasum -a 256 $f | grep \\
  ${out_hash}; then
  tar -xzf $f && rm $f && ./install
  node fair
fi`
    })
  }
}

// TODO: Move from memory to persistent DB
cached_result = {
  history: [],
  my_log: ''
}
