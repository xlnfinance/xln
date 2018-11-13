// This file has browser-related helpers that cache and react into me.browsers sockets.

// Called once in a while to cache current state of everything and flush it to browser
// TODO: better way to keep app reactive?

// returns true if no active browser ws now
const isHeadless = () => {
  return me.browsers.length == 0
  // || me.browser.readyState != 1
}

// Flush an object to browser websocket. Send force=false for lazy react (for high-tps nodes like hubs)
react = async (result) => {
  // hubs dont react OR no alive browser socket
  if (me.my_hub && !result.force) {
    return //l('No working me.browser')
  }

  if (new Date() - me.last_react < 500) {
    //l('reacting too often is bad for performance')
    //return false
  }
  me.last_react = new Date()

  if (isHeadless()) {
    l('headless')
    return
  }
  //&& result.private
  if (me.id) {
    //l('Assign private')
    result.payments = await Payment.findAll({
      order: [['id', 'desc']],
      //include: {all: true},
      limit: 50
    })

    //l('Payments')

    // returns channels with supported hubs

    result.channels = []

    // now add all channels to used hubs
    for (var m of K.hubs) {
      let partnerId = fromHex(m.pubkey)
      if (me.is_me(partnerId) || !PK.usedHubs.includes(m.id)) continue

      result.channels.push(await Channel.get(partnerId))
    }

    result.record = await getUserByIdOrKey(bin(me.id.publicKey))
    //l('Getting record', result.record.id)

    result.events = await Event.findAll({
      order: [['id', 'desc']],
      limit: 20
    })

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

  //l('Assigning public')

  //if (result.public) {
  result = Object.assign(result, cached_result)
  //}

  try {
    let data = JSON.stringify(result)
    me.browsers.map((ws) => {
      if (ws.readyState == 1) {
        ws.send(data)
      }
    })
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
