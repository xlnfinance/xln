/*
Consensus Reactor fires up every second and based on Unix ts() triggers an action
This is a state machine where each transition is triggered by going to next step (time-based).
Inspired by: https://tendermint.readthedocs.io/en/master/getting-started.html

Unlike tendermint we have no interest in fast 3s blocks and aim for "fat" blocks and low validator sig overhead with blocktime 1-10min. Also "await" step was added when validators are idle.

See external_rpc for other part of consensus.

|====propose====|====prevote====|====precommit====|================await==================|

propose > prevote on proposal or nil > precommit if 2/3+ prevotes or nil > commit if 2/3+ precommits and await.

Long term TODO: redundancy reduced gossip. For now with validators <= 100, everyone sends to everyone.

Byzantine (CHEAT_) scenarios for validator to attack network.

Expected security properties:
1/3- cannot make forks or deadlock consensus
2/3- cannot make forks w/o powerful network partition
1/3+ can attempt fork with partion. can deadlock by going offline
2/3+ can do anything

for all scenarios we use 4 nodes: A B C D each with 25% stake. We must tolerate 1 compromised node (A).

1. A gives all three different blocks.
= no block gains 2/3+ prevotes, next node is honest.

2. A proposes block1 to B C and block2 to D.
= block1 gains 3 prevotes, B and C precommit to block 1. A cheats on them and never gossips its own precommit. This round is failed. Next round B is still locked on block1 and proposes block1 again. B C and D all prevote and precommit on it = block1 is committed.

*/

module.exports = async () => {
  var second = ts() % K.blocktime

  var phase

  if (second < K.step_latency) {
    phase = 'propose'
  } else if (second < K.step_latency * 2) {
    phase = 'prevote'
  } else if (second < K.step_latency * 3) {
    phase = 'precommit'
  } else {
    phase = 'await'
  }

  if (me.status == 'await' && phase == 'propose') {
    me.status = phase

    //l('Next round', me.next_member().id)

    if (me.my_member == me.next_member()) {
      //l(`it's our turn to propose, gossip new block`)

      if (K.ts < ts() - K.blocktime) {
        l("Danger: No previous block exists")
      }

      if (me.proposed_block.locked) {
        l(`We precommited to previous block, keep proposing it`)
        var {header, ordered_tx_body} = me.proposed_block
      } else {
        // otherwise build new block from your mempool
        var ordered_tx = []
        var total_size = 0
        var meta = {dry_run: true}
        for (var candidate of me.mempool) {
          if (total_size + candidate.length >= K.blocksize) {
            l(`The block is out of space, stop adding tx`)
            break
          }

          var result = await me.processBatch(candidate, meta)
          if (result.success) {
            ordered_tx.push(candidate)
            total_size += candidate.length
          } else {
            l(`Bad tx in mempool`, result)
            // punish submitter ip
          }
        }
        // sort by fee (optimize for profits)

        // flush it or pass leftovers to next validator
        me.mempool = []

        // Propose no blocks if mempool is empty
        if (ordered_tx.length > 0 || K.ts < ts() - K.skip_empty_blocks) {
          var ordered_tx_body = r(ordered_tx)

          var header = r([
            methodMap('propose'),
            me.record.id,
            K.total_blocks,
            Buffer.from(K.prev_hash, 'hex'),
            ts(),
            sha3(ordered_tx_body),
            current_db_hash()
          ])
        } else {
          var header = false
        }
      }

      if (header) {
        var propose = r([
          bin(me.block_keypair.publicKey),
          bin(ec(header, me.block_keypair.secretKey)),
          header,
          ordered_tx_body
        ])

        if (me.CHEAT_dontpropose) {
          l('CHEAT_dontpropose')
        } else {
          //l('Broadcast header ', toHex(header))

          setTimeout(() => {
            me.gossip('propose', propose)
          }, K.gossip_delay)
        }
      }
    }
  } else if (me.status == 'propose' && phase == 'prevote') {
    me.status = phase

    // gossip your prevotes for block or nil
    var prevotable = me.proposed_block ? me.proposed_block.header : 0

    setTimeout(() => {
      me.gossip('prevote', me.block_envelope(methodMap('prevote'), prevotable))
    }, K.gossip_delay)
  } else if (me.status == 'prevote' && phase == 'precommit') {
    me.status = phase

    // gossip your precommits if have 2/3+ prevotes or nil

    // do we have enough prevotes?
    var shares = 0
    Members.map((c, index) => {
      if (c.prevote) {
        shares += c.shares
      }
    })

    if (shares >= K.majority) {
      var precommitable = me.proposed_block.header

      // lock on this block. Unlock only if another block gets 2/3+
      me.proposed_block.locked = true
    } else {
      var precommitable = 0
    }

    if (me.CHEAT_dontprecommit) {
      //l('We are in CHEAT and dont precommit ever')
    } else {
      setTimeout(() => {
        me.gossip(
          'precommit',
          me.block_envelope(methodMap('precommit'), precommitable)
        )
      }, K.gossip_delay)
    }
  } else if (me.status == 'precommit' && phase == 'await') {
    me.status = phase

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
      if (!me.proposed_block.locked) me.proposed_block = {}

      l(
        `Failed to commit, only ${shares} precommits / ${K.majority}. Lets sync`
      )
      sync()
    } else if (me.proposed_block.header) {
      // adding to our external queue to avoid race conditions
      // we don't call processBlock directly to avoid races
      RPC.external_rpc(
        null,
        concat(
          bin(methodMap('chain')),
          r([
            [
              precommits,
              me.proposed_block.header,
              me.proposed_block.ordered_tx_body
            ]
          ])
        )
      )
      me.proposed_block = {}
    }
  }

  setTimeout(()=>{
    q('onchain', me.consensus)
  }, 500) // watch for new events

  return true
}
