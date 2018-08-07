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
const await_propose = require('./propose')

const propose_prevote = require('./prevote')

const prevote_precommit = require('./precommit')

const precommit_await = require('./await')

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
  await section('onchain', async () => {
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
    setTimeout(me.consensus, 100)
  })
  return true
}
