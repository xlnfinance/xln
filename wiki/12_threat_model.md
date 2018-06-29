# Threat Model

Fairlayer has a very strong security model, but no system is perfect and under specific conditions (which are engineered to be very unlikely), the system can be compromised and lead to funds loss.

## Onchain

1. Protection from malicious validator majority

First of all, the entire point of Fairlayer is to separate the blockchain into onchain (insurance layer) and offchain (payments layer). That allows every consumer device to be a full node, and there are no light clients.

Therefore it is impossible for validator majority to change consensus privately and produce invalid blocks with someone's funds destroyed or created out of thin air.

Without this inevitable light client flaw, there would be no scaling debate as blocksize could have been safely increased.

2. Forks/double spends/consensus split

However, validator majority still can produce a fork which can contain double spends. In the result various groups of nodes may end up on completely different states, and there will be no "right" state as all blocks are valid and contain 2/3+ precommits. Well-prepared double spend attacks are deadly, and there is no known recovery process. 

**In order to create a fork 1/3+ of voting power would have to be compromised.** 

By using PoA to mitigate Sybil attacks (1 node 1 vote) and raising the number of nodes to 10,000 we are trying to increase the Nakamoto coefficient (also referred as Byzantine tolerance) to 3,333 making it insanely hard to compromise so many entities all over the world at the same time.

3. Evil onchain governance

Onchain governance allows to introduce new features quickly, painlessly and simultaneously. However, the main disadvatedge of onchain governance is that some changes can be malicious for the benefit of validator(s). For instance, majority of validators may decide to print them more assets or to ban good users they don't like. 

We propose 3 ways to resolve this problem:

* Keep the "bench" of substitute validators like in football: with a hard fork users can decide to replace current validators with new ones.

* Require rotation & election (the same way presidents in most countries can't serve more than twice in a row)

* Make it harder to add a new change every year by raising the acceptance bar, increasing delay periods, or even eventually disable onchain governance and make the updates opt-in by the users.

Cartel of onchain governance is probably the hardest problem Fairlayer hasn't solved yet, but we can always safely change that.

## Offchain

As long as onchain layer is correct and 2/3+ of validators are online and honest, it doesn't really matter what happens offchain. All hubs may be compromised at once, and it still wouldn't be a big deal beyond temporary downtime.

**If you're a hacker, we've prepared a guide** how to maximize your profits if you managed to break into a Fair hub.

1. Withdraw all the assets the hub owns with net-spenders.

The hub has "insured" balances with users, which means this funds can be claimed by the hub. Make the hub request withdrawal proofs from all users that are currently online, and use them to depositTo your own account. With offline users you may try to start disputes, but then you can't get access to those funds instantly. Once you've withdrawn everything to your account, start mixing it asap because otherwise our detection scripts may catch you.

2. Promise money on behalf of the hub

The whole point of uninsured balances is those are promised. The users define credit hard_limit that limits maximum amount of assets they can lose. You should target various crypto exchanges where you can instantly sell the assets for Bitcoins and withdraw them, because promising fake funds to regular people is very hard to monetize.

If 10 exchanges have hard_limit at $10k, you can deposit to them up to $100k and sell that for other assets. 

After it becomes apparent the hub is compromised and insolvent, the users would have to cover the losses on their own (that's why the balance is called uninsured). Your total profits will be equal total uninsured balances + the hard limits you managed to exhaust with automatic exchange services.



## Infrastructure

What every other blockchain misses, is that the way software is installed and updated is just as important as consensus itself.

1. Decentralized install

Fairlayer for desktop can be installed by verifying short cryptographic install snippets from many trustworthy sources. This removes central point of failure (while bitcoin.org may serve malware for very long time unnoticed).

2. Decentralized updates

All updates, even small ones like color of a button, are delivered through onchain governance which requires explicit signatures by 2/3+ of validators. This also removes central point of failure (a single compromised maintainer in other blockchains can upload bad code to github)

3. Dependencies

All yarn dependencies will be vendored and audited in the nearest future.


4. Key storage

The primary auth offered in the default wallet is a strong brainwallet `scrypt(email+pw)` (inspired by WarpWallet). If you're able to find a faster way to calculate scrypt at current parameters plus iterate the salt (username) against large dataset of passwords, you may be able to break into a lot of accounts with simple passwords. That's the trade-off we made in order to increase usability of private key management.

5. Browser sandbox

Currently Fairlayer runs as a web app served from localhost, therefore if you manage to bypass browser sandbox and execute arbitrary code at `127.0.0.1:8001` you may be steal all funds.


