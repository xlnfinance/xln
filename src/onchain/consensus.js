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
const await_propose = async () => {
  me.status = 'propose'

  //l('Next round', nextValidator().id)
  if (me.my_validator != nextValidator()) {
    return
  }

  //l(`it's our turn to propose, gossip new block`)
  if (K.ts < ts() - K.blocktime) {
    l('Danger: No previous block exists')
  }

  let header = false
  let ordered_tx_body

  if (me.proposed_block.locked) {
    l(`We precommited to previous block, keep proposing it`)
    ;({header, ordered_tx_body} = me.proposed_block)
  } else {
    // otherwise build new block from your mempool
    let total_size = 0
    const ordered_tx = []
    const meta = {dry_run: true}
    for (const candidate of me.mempool) {
      if (total_size + candidate.length >= K.blocksize) {
        l(`The block is out of space, stop adding tx`)
        break
      }

      const result = await me.processBatch(candidate, meta)
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
      ordered_tx_body = r(ordered_tx)
      header = r([
        methodMap('propose'),
        me.record.id,
        K.total_blocks,
        Buffer.from(K.prev_hash, 'hex'),
        ts(),
        sha3(ordered_tx_body),
        current_db_hash()
      ])
    }
  }

  if (!header) {
    return
  }

  var propose = r([
    bin(me.block_keypair.publicKey),
    bin(ec(header, me.block_keypair.secretKey)),
    header,
    ordered_tx_body
  ])

  if (me.CHEAT_dontpropose) {
    l('CHEAT_dontpropose')
    return
  }
  //l('Broadcast header ', toHex(header))

  setTimeout(() => {
    me.gossip('propose', propose)
  }, K.gossip_delay)
}

const propose_prevote = () => {
  me.status = 'prevote'

  // gossip your prevotes for block or nil
  const prevotable = me.proposed_block ? me.proposed_block.header : 0

  setTimeout(() => {
    me.gossip('prevote', me.block_envelope(methodMap('prevote'), prevotable))
  }, K.gossip_delay)
}

const prevote_precommit = () => {
  me.status = 'precommit'

  // gossip your precommits if have 2/3+ prevotes or nil

  // do we have enough prevotes?
  let shares = 0
  Validators.map((c, index) => {
    if (c.prevote) {
      shares += c.shares
    }
  })

  let precommitable = 0
  if (shares >= K.majority) {
    precommitable = me.proposed_block.header

    // lock on this block. Unlock only if another block gets 2/3+
    me.proposed_block.locked = true
  }

  if (me.CHEAT_dontprecommit) {
    //l('We are in CHEAT and dont precommit ever')
    return
  }

  setTimeout(() => {
    me.gossip(
      'precommit',
      me.block_envelope(methodMap('precommit'), precommitable)
    )
  }, K.gossip_delay)
}

const precommit_await = () => {
  me.status = 'await'

  // if have 2/3+ precommits, commit the block and share
  let shares = 0
  const precommits = []
  Validators.map((c, index) => {
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

    l(`Failed to commit, only ${shares} precommits / ${K.majority}. Lets sync`)
    sync()
  } else if (me.proposed_block.header) {
    // adding to our external queue to avoid race conditions
    // we don't call processBlock directly to avoid races
    require('./chain')([
      [precommits, me.proposed_block.header, me.proposed_block.ordered_tx_body]
    ])
    me.proposed_block = {}
  }
}

const compute_phase = () => {
  const second = ts() % K.blocktime
  if (second < K.step_latency) {
    return 'propose'
  } else if (second < K.step_latency * 2) {
    return 'prevote'
  } else if (second < K.step_latency * 3) {
    return 'precommit'
  } else {
    return 'await'
  }
}

module.exports = async () => {
  const phase = compute_phase()

  if (me.status == 'await' && phase == 'propose') {
    await await_propose()
  } else if (me.status == 'propose' && phase == 'prevote') {
    propose_prevote()
  } else if (me.status == 'prevote' && phase == 'precommit') {
    prevote_precommit()
  } else if (me.status == 'precommit' && phase == 'await') {
    precommit_await()
  }

  // watch for new events
  setTimeout(() => {
    q('onchain', me.consensus)
  }, 500)

  return true
}
