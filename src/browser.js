// This file has browser-related helpers that cache and react into me.browser socket.

// Called once in a while to cache current state of everything and flush it to browser
// TODO: better way to keep app reactive?

// returns true if no active browser ws now
const isHeadless = () => {
  return !me.browser || me.browser.readyState != 1
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
    //await Periodical.syncChanges()
  }

  if (isHeadless()) return

  //await Periodical.updateCache()

  if (me.id && !result.skip_private) {
    ;[
      result.payments,
      result.channels,
      result.record,
      result.events
    ] = await Promise.all([
      Payment.findAll({
        order: [['id', 'desc']],
        //include: {all: true},
        limit: 300
      }),
      me.channels(),
      getUserByIdOrKey(bin(me.id.publicKey)),
      Event.findAll({
        order: [['id', 'desc']],
        limit: 100
      })
    ])

    if (!result.record.id) result.record = null

    result.timeouts = Object.keys(Periodical.timeouts)

    result.payments.map((p) => {
      // prefix for invoice types: 1 is user set 2 is random
      if (p.invoice) {
        p.invoice = p.invoice
          .slice(1)
          .toString(p.invoice[0] == 1 ? 'utf8' : 'hex')
      }
    })

    result.PK = PK

    result.address = me.getAddress()
    result.pubkey = toHex(me.pubkey)
    result.batch = me.batch
    result.batch_estimate = await me.batch_estimate()
  }

  if (isHeadless()) return

  try {
    me.browser.send(
      JSON.stringify({
        result: result //Object.assign(result, cached_result)
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
