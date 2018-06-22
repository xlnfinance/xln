# Consensus: PoA + Tendermint

Our consensus was inspired by <a href="https://tendermint.com/">Tendermint-based</a>. In this chapter our job is to explain exactly where each constant or ratio comes from, not just throw facts/specification at you. We will try to **follow the logic from simple implementation to three phase commit** so you will see potential threats in a story-telling fashion and how they are solved here.

# Why PoS not PoW

Proof of Work is dead: https://medium.com/@homakov/stop-calling-bitcoin-decentralized-cb703d69dc27

Most people focus on the fact that it's energy wasteful, yes, but that's not the main culprit. The main problem has always been very high centralization of this consensus. There are 3 mining pools both in btc and eth that needs to be compromised to create a fork (aka the game over of blockchains). A fork can lead to some heavy double-spends that completely undermine security principles and trust into the platform. Those would be deadly.

There's no way to "fix" proof of work. No algorithm change can achieve better stake distribution in a long term. Any algorithm is optimizable, ASIC-able, and gravitates to centralized entities. The fact that they have no incentive to compromise the ledger right now isn't a guarantee it can't happen in the future, nor it guarantees they won't be coerced into doing that (China can hack Bitcoin any time now https://medium.com/@homakov/how-to-destroy-bitcoin-with-51-pocked-guide-for-governments-83d9bdf2ef6b)

That's why our consensus of choice is proof of stake, where stake is represented by identity. Our validators are  verified by master of ceremony. Pretty much like proof of authority (we mostly agree with points raised in blog posts of https://poa.network/) but the "authority" word has bad flavor so let's stick to PoS.

However, at some point in the future, we might release experimental "classic" version of this system which would be mineable, just because so many people prefer the old school approach.

# Why 2/3+?

Given, we are granting 100 stake-tokens to ourselves (master of ceremony) and distribute them to 99 other entities after verifying their social accounts (the more famous the better, less chance of Sybil).

Each block must be signed by `2/3+` of total stake, can tolerate up to `1/3-` and may be compromised if 1/3+ is compromised and only 2/3- honest left. 


```
for(var i=1;i<300;i++){ 
  var honest = i%3==0?i*2/3+1:Math.ceil(i*2/3)
  console.log(`${i} validators require honest ${honest} and can tolerate up to ${i-honest} Byzantine. Must compromise ${i-honest+1}`) 
} 
```

Demo output:

```
95 validators require honest 64 and can tolerate up to 31 Byzantine. Must compromise 32
96 validators require honest 65 and can tolerate up to 31 Byzantine. Must compromise 32
97 validators require honest 65 and can tolerate up to 32 Byzantine. Must compromise 33
98 validators require honest 66 and can tolerate up to 32 Byzantine. Must compromise 33
99 validators require honest 67 and can tolerate up to 32 Byzantine. Must compromise 33
100 validators require honest 67 and can tolerate up to 33 Byzantine. Must compromise 34
101 validators require honest 68 and can tolerate up to 33 Byzantine. Must compromise 34
```

You can run this js to see what amount of validators require honest/malicious nodes to properly function. Where this `2/3` is coming from? Simple visual demo:

Say there are 4 validators (we always assume each has 1 stake only). How much should we require to have a valid block?

`====`

If we require all 4, a single failing node going offline would stop the consensus. If we require 2, a single Byzantine node can rely on some network partition and double-sign (create a fork) with 1 on the left and 2 on the right. Which means we must require at least 3 honest nodes to tolerate one malicious one. 4 validators is absolute minimum that makes sense in Byzantine environment, anything less doesn't allow any malicious nodes.

So on one hand we must not require too much to ensure liveness of the protocol. If we require 95%, 5% going offline would stop everything. On another hand if we require 51%, by compromising just 2% we can get a fork by sending two separate groups (49% and 49% respectively) two different blocks. That would require some network partition and state actor power, but that's doable.

This is why we are choosing the middle requirement at 1/3- (the minus means less than) that ensures if 1/3- goes offline or tries to sign dubiously, the fork can't happen as long as the rest of the nodes 2/3+ are honest. 1/3+ however can achieve that. The -/+ at the end denotes rounding logic that can be seen from JS snippet above.

Now let's try to build the specification around that.

# The Obvious approach

Each round we deterministically decide who proposes a new block. That's pretty easy: we take Unix timestamp, divide by blocktime:

`epoch = Math.floor(timestamp() / blocktime)` 

`current_validator = epoch % validators.length`

This validator must broadcast to everyone else signed block built from tx taken from their mempool, receive signatures back, and as soon as they receive 2/3+ of sigs they can broadcast to all users valid and final block, prepended with commitments from other validators:

`sig1,sig2,sig3...|blockdata`

No validator must ever sign on top of the same height twice, which prevents forks.

This simple approach guarantees there won't be forks if 2/3+ are honest. But...

# Obvious mistakes

It is not so easy. Imagine, the malicious validator received the signatures and went offline forever. The whole network is now in a dead lock, because they never received the valid block back but locked in on this height so cannot continue building a new one.



