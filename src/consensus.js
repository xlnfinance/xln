// Consensus Reactor - run by validators every second


// TODO: Comply with tendermint consensus. Unlike tendermint we have no interest in fast 3s blocks and aim for "fat" blocks and low validator sig overhead with blocktime 1-10min

/*
This is a state machine where each transition is triggered by going to next step (time-based).


0 propose
10 broadcast everyone prevote on proposal or nil
20 precommit if have prevotes 2/3+

propose > prevote > precommit > commit

*/



module.exports = async () => {
  var now = ts()
  var round = 5

  var currentIndex = Math.floor(now / K.blocktime) % K.total_shares

  var searchIndex = 0



  for (var i in Members) {
    searchIndex += Members[i].shares

    if (currentIndex < searchIndex) {
      me.current = Members[i]

      var increment = (K.blocktime - (now % K.blocktime)) < 2 ? 2 : 1

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
  

  var second = now % K.blocktime
  var phase = second < 5 ? 'propose' : (second < 10 ? 'prevote' : (second < 15 ? 'precommit' : 'commit'))
  


  // reactive state machine
  if (me.current == me.my_member && me.status == 'await' && phase == 'propose') {
      me.status = 'proposed'

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

    if (me.status == 'precommit' && (now % K.blocktime > K.blocktime - round)) {
      if (total_shares < K.majority) {
        l(`Only have ${total_shares} shares, cannot build a block!`)
      } else {
        await me.processBlock(concat(
            Buffer.concat(sigs),
            me.precommit
          ))
        fs.writeFileSync('data/k.json', stringify(K))

      }
        // flush sigs
      Members.map(c => c.sig = null)

      me.status = 'await'
    } 


  setTimeout(me.consensus, 1000)

}
