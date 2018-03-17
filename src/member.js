// Code run by validator to build blocks
// TODO: Comply with tendermint consensus
module.exports = async () => {
  var now = ts()

  var currentIndex = Math.floor(now / K.blocktime) % K.total_shares

  var searchIndex = 0
  for (var i in Members) {
    searchIndex += Members[i].shares

    if (currentIndex < searchIndex) {
      me.current = Members[i]

      var increment = (K.blocktime - (now % K.blocktime)) < 5 ? 2 : 1

      if (currentIndex + increment >= searchIndex) {
        // take next member or rewind back to 0
        me.next_member = Members[(i + increment) % K.members.length]
      } else {
        // next slot is still theirs
        me.next_member = me.current
      }
      break
    }
  }

  // d(`Status ${me.status} at ${now} Current: ${me.current.id}, next: ${me.next_member.id}.`)

  if (me.my_member == me.current) {
      // do we have enough sig or it's time?
    var sigs = []
    var total_shares = 0
    Members.map((c, index) => {
      if (c.sig) {
        sigs[index] = bin(c.sig)
        total_shares += c.shares
      } else {
        sigs[index] = Buffer.alloc(64)
      }
    })

    if (me.status == 'precommit' && (now % K.blocktime > K.blocktime - 5)) {
      if (total_shares < K.majority) {
        l(`Only have ${total_shares} shares, cannot build a block!`)
      } else {
        me.processBlock(concat(
            Buffer.concat(sigs),
            me.precommit
          ))
      }
        // flush sigs
      Members.map(c => c.sig = null)

      me.status = 'await'
    } else if (me.status == 'await' && (now % K.blocktime < K.blocktime - 5)) {
      me.status = 'precommit'

      // processing mempool
      var ordered_tx = []
      var total_size = 0

      var meta = {dry_run: true}

      for (var candidate of me.mempool) {
        if (total_size + candidate.length > K.blocksize) break

        var result = await Tx.processTx(candidate, meta)
        if (result.success) {
          ordered_tx.push(candidate)
          total_size += candidate.length
        } else {
          l(result.error)
          // punish submitter ip
        }
      }

      // flush it
      me.mempool = []

      me.precommit = r([
        methodMap('block'),
        me.record.id,
        Buffer.from(K.prev_hash, 'hex'),
        ts(),
        ordered_tx
      ])

      me.my_member.sig = ec(me.precommit, me.block_keypair.secretKey)

      if (K.majority > 1) {
        var needSig = r([
          me.my_member.block_pubkey,
          me.my_member.sig,
          me.precommit
        ])

        Members.map((c) => {
          if (c != me.my_member) { me.send(c, 'needSig', needSig) }
        })
      }

      return me.precommit

    }
  } else {
    me.status = 'await'
  }
}
