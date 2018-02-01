module.exports = () => {
  var now = ts()

  var currentIndex = Math.floor(now / K.blocktime) % K.members.length
  me.current = me.members[currentIndex]

  var increment = (K.blocktime - (now % K.blocktime)) < 10 ? 2 : 1

  me.next_member = me.members[ (currentIndex + increment) % K.members.length]

    // l(`Current member at ${now} is ${me.current.id}. ${me.status}`)

  if (me.my_member == me.current) {
      // do we have enough sig or it's time?
    var sigs = []
    var total_shares = 0
    me.members.map((c, index) => {
      if (c.sig) {
        sigs[index] = bin(c.sig)
        total_shares += c.shares
      } else {
        sigs[index] = Buffer.alloc(64)
      }
    })

    if (me.status == 'precommit' && (now % K.blocktime > K.blocktime - 10)) {
      if (total_shares < K.majority) {
        d(`Only have ${total_shares} shares, cannot build a block!`)
      } else {
        d('Lets process the finalblock we just built')

        me.processBlock(concat(
            Buffer.concat(sigs),
            me.precommit
          ))
      }
        // flush sigs
      me.members.map(c => c.sig = false)

      me.status = 'await'
    } else if (me.status == 'await' && (now % K.blocktime < K.blocktime - 10)) {
      me.status = 'precommit'
      me.processMempool()
    }
  } else {
    me.status = 'await'
  }
}
