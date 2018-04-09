/*
Consensus Reactor - run by validators every second
This is a state machine where each transition is triggered by going to next step (time-based).
Inspired by: https://tendermint.readthedocs.io/en/master/getting-started.html

Unlike tendermint we have no interest in fast 3s blocks and aim for "fat" blocks and low validator sig overhead with blocktime 1-10min. Also "await" step was added when validators are idle.

See external_rpc for other part of consensus.


0 propose
10 broadcast everyone prevote on proposal or nil
20 precommit if have prevotes 2/3+

|====propose====|====prevote====|====precommit====|================await==================|

propose > prevote on proposal or nil > precommit if 2/3+ prevotes or nil > commit if 2/3+ precommits and await.


Long term TODO: redundancy reduced gossip. For now with validators <= 100, everyone sends to everyone.
*/

module.exports = async () => {
  var now = ts()

  var second = now % K.blocktime
  var phase = second < 5 ? 'propose' : (second < 10 ? 'prevote' : (second < 15 ? 'precommit' : 'await'))
  


  if (me.status == 'await' && phase == 'propose') {
      me.status = 'propose'

      // it's our turn to propose, gossip new block
      if (me.my_member == me.next_member()) {
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

        // sort by fee

        // flush it
        me.mempool = []

        var ordered_tx_body = r(ordered_tx)
        var tx_root = sha3(ordered_tx_body)

        var header = r([
          methodMap('block'),
          me.record.id,
          Buffer.from(K.prev_hash, 'hex'),
          ts(),
          tx_root
        ])

        var propose = r([
          me.my_member.block_pubkey,
          ec(me.proposal, me.block_keypair.secretKey),
          header,
          ordered_tx_body
        ])

        me.gossip('propose', propose) // todo: gossip a bit later to avoid clock skews

      }



  } else if (me.status == 'propose' && phase == 'prevote') {
    me.status = 'prevote'

    // gossip your prevotes for block or nil
    var prevotable = me.proposed_block ? me.proposed_block.header : 0 

    me.gossip('prevote', me.envelope(methodMap('prevote'), prevotable))

  } else if (me.status == 'prevote' && phase == 'precommit') {
    me.status = 'precommit'

    // gossip your precommits if have 2/3+ prevotes or nil

    // do we have enough prevotes?
    var shares = 0
    Members.map((c, index) => {
      if (c.prevote) {
        shares += c.shares
      }
    })

    var precommitable = shares >= K.majority ? me.proposed_block.header : 0

    // me.lock
    me.gossip('precommit', me.envelope(methodMap('precommit'), precommitable))

  } else if (me.status == 'precommit' && phase == 'await') {
    me.status = 'await'

    // if have 2/3+ precommits, commit the block and share
    var shares = 0

    var precommits = []
    Members.map((c, index) => {
      if (c.precommit) {
        shares += c.shares
        precommits[index] = c.precommit
      } else {
        precommits[index] = 0
      }

      // flush sigs for next round
      c.prevote = null
      c.precommit = null
    })

    if (shares < K.majority) {
      return l(`Failed to commit, only ${shares} precommits / ${K.majority}`)
    }

    var block = r([precommits,
        me.proposed_block.header,
        me.proposed_block.ordered_tx_body
      ])

    await me.processBlock(block)
    fs.writeFileSync('data/k.json', stringify(K))
  }







  setTimeout(me.consensus, 1000) // watch for new events in 1 s
}
