module.exports = async (args) => {
  // New payment arrived
  let [pubkey, sig, body] = args

  if (!ec.verify(body, sig, pubkey)) {
    return l('Wrong input')
  }

  //l(msg.length, ' from ', trim(pubkey), toHex(sha3(msg)))

  // ackSig defines the sig of last known state between two parties.
  // then each transitions contains an action and an ackSig after action is committed
  let [method, asset, ackSig, transitions, debug] = r(body)
  if (methodMap(readInt(method)) != 'update') {
    loff('Invalid update input')
    return false
  }

  asset = readInt(asset)

  let flushable = await q([pubkey, asset], async () => {
    //loff(`--- Start update ${trim(pubkey)} - ${transitions.length}`)
    return me.updateChannel(pubkey, asset, ackSig, transitions, debug)
  })

  /*
  We MUST ack if there were any transitions, otherwise if it was ack w/o transitions
  to ourselves then do an opportunistic flush (flush if any). Forced ack here would lead to recursive ack pingpong!
  Flushable are other channels that were impacted by this update
  Sometimes sender is already included in flushable, so don't flush twice
  */

  let flushed = [me.flushChannel(pubkey, asset, transitions.length == 0)]

  if (flushable) {
    for (let fl of flushable) {
      // can be opportunistic also
      if (!fl.equals(pubkey)) {
        flushed.push(me.flushChannel(fl, asset, true))
      } else {
        loff('Tried to flush twice')
      }
      //await ch.d.requestFlush()
    }
  }
  await Promise.all(flushed)

  // use lazy react for external requests
  react({}, false)

  return
}
