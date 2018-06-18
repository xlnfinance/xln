# Mediation

The main benefit of offchain scaling is ability to instantly send money at almost no cost between 2 parties. But, since there are more users in the world, it leads to banks, hubs and centralized exchanges servers.

The problem it creates is how do we do the transfer from Alice to Hub then Hub to Bob in a trustless manner? 

## The problem of Hashed Timelock

In many blockchains it's possible to construct an offchain payment proof in a way that it's only valid when you have a secret that unlocks some challenge. Normally it's a sha256 hash that's also limited with a time constraint - i.e. it can only be used in next 10 blocks.

This allows us to perform nested and multilayered transactions that may involve asset transfer, asset exchange and even cross-blockchain swaps. 

1. Alice sends Hub1 a proof that's valid for 30 blocks and requires a S  that unlocks it (and it includes sha256(S) provided by Bob)

2. Hub1 sends a proof to Hub2 valid for 20 blocks with same condition.

3. Hub2 sends a proof to Bob valid for 10 blocks

4. Bob now has to return Hub2 the S that unlocks the whole chain, because Bob technically has the money for next __10 blocks__ and can submit it to blockchain to claim it. 

5. Once Hub2 gets the S, they are assured they own the money from step 2 but also __for next ~20 blocks__ so they give Bob an  __unlocked/unconditional transfer__ and return S to Hub1.

6. Same, Hub1 now owns the money and returns Hub2 unlocked transfer and returns S down to Alice.

7. Alice sees the S and knows the payment chain was successful, returns unlocked proof to Hub1.

It all looks good but the problem here is a targeted denial of service against Alice by Bob.

Let's say Bob is a completely random user and Alice is a heavily used merchant processing 10 payments per second. If Alice is made to do a refund to Bob via chain of hashlocked transfers and Bob doesn't return S to Hub2, everyone else now has to wait for 10 blocks to ensure Hub2-Bob payment proof expires, then another 10 blocks for Hub1-Hub2 to expire and so on.

__Because it's unclear will Bob claim the money or won't. Based on that all previous parties cannot operate with each other - the status of their payment proofs is hang in the air__.

It means both Hub1-hub2 relationship is **stale for 20 blocks** which could be several hours. And Alice, heavily used merchant, now cannot accept new payments for even longer time!

This 10 blocks delay also cannot be any smaller, since it's important to give a skew time of at least a couple of blocks in case of full blocks or validator censorship.

## Trusted Chunks

The only quick fix solution to this problem is to send small eg $1 unlocked payments all the way to Bob, and see if they return S, then do another $1 payment. This means you can lose as little as $1 but you don't risk waiting for 30 blocks to ensure Bob won't publish their proof into blockchain around 9th block. 

However, for larger payments you would need to do as many full roundtrips sender-receiver as many chunks in a transfer. For $10k transfer $10 chunk it would take 1000 roundtrips. Even with low latency at 20ms it would take 20 seconds to finish the whole transfer. You can try to raise the chunk size to $100 but then you allow the hub to steal $100 which is for most people sizeable amount of money, and have plausible deniability. 

Since there is no legal practice around blockchains, **there's nothing to stop bad behavior from stealing since they know there is no punishment and no way to prove the chunk was stolen.**


## Hybrid

We are planning to send all transfers below specific amounts (eg $1000) in low value trusted chunks, and bigger ones via hashlocks (not implemented yet)







