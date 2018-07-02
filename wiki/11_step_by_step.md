# From Genesis to Rebalance

Two layered blockchains are much harder to understand and reason about, so let's try to explain the entire process step by step who-sends-what-to-who, from the genesis, first channel deposit, first hashlocked payment and finally to rebalance.

## Genesis

Fair uses identity-based consensus which is a subset of Proof-of-Stake.
 There is an array K.members (K is the main configuration object) which contains details about current validators and `shares` field that says what voting power they currently have (the goal is to have 1 identity 1 share).

![/wiki/step1.png](/wiki/step1.png)


Initially there will be 4 servers in different countries hosted with different cloud providers on domains **fairlayer.{com,org,net,network}** each having 25 shares.

This means if one of the servers goes Byzantine, the system is still safe. Obviously, the network is entirely centralized on day 1 and our job is to distribute those shares to public identities within next 3 years. 

## First snapshot

At block one, each validator will create a snapshot Fair-1.tar.gz file which can be used by anyone to setup a new node, optionally verifying the hashes visually.

During blockchain growth, each `K.snapshot_after_bytes` (we don't say exact values as they can be changed later) there will be a new `Fair-CURRENTHEIGHT.tar.gz` generated making it easier to bootstrap a new node jumping straight on the recent network state, even after entire blockchain length can exceed 1 terabyte years after.

## Native assets: FRD & FRB

These assets are generated during genesis, and each validator is given a small chunk of money on their onchain balances (which is represented in `onchain/db.sqlite` which all full nodes maintain exact copy of). Now they can send it onchain to other accounts the traditional way, but that is a slow and inefficient way for value transfers. 

We are all about offchain so let's do offchain.

## Channel deposit

The first validator is also a hub `@main` (see K.hubs). Let's say second account wants to deposit money to 2@1 (think of it as '2' account in bank '1' like in email notation).

They may do it in console or open up default wallet, visit Onchain tab and type 5000 FRD and destination "2@1" then press Execute Onchain.

## Adding tx to batch

The wallet does not immediately send the transaction to validators. That would be very inefficient. Instead it gives the user time to perform more transactions, maybe vote on a proposal or start a dispute, and then send all these actions in a `batch` with single signature.

So once tx is part of a batch, this signed batch is broadcasted to `next_validator()` which returns a URL of validator that's just about to build a block.

The validator adds the batch to their mempool and when it's their time (according to `onchain/consensus.js`) to build a block, they make a simple verification that the user that made the batch has enough money on their onchain balance to cover the tax fee which is simply `K.tax * tx.length`. No other processing is done. Also, one user may only include one batch per block.

## Sync

Meanwhile, every single full node is trying to stay in sync. Which means they randomly send `sync` requests to backbone nodes: validators, hubs, and other services that have a public URL, 24/7 uptime, beefy servers and are happy to share blocks with others. (this may be changed to more decentralized p2p model in the future)

For block to be valid it must be prepended with 2/3+ precommit signatures. So when our node gets a new block, it verifies against local K.members each signature and once the block gains 2/3+ voting power confirming it, we can safely split it into batches and process batches one by one: see `onchain/process_batch.js` that does just that.

## Processing the block

Once each full node gets to our batch, it substracts the fee from our onchain balance in their onchain db and sends it to current validator's onchain balance (also known as "miner fee").

Then it sees all the actions inside the batch and executes it. Our action is `depositTo` with giveTo=2 (us) and withPartner=1 (the hub).

Each node checks are we left user or right by comparing 1 & 2 public keys. Let's say 2 is left user, which means each node now substracts 5000 from 2's onchain balance, creates a new record in "insurances" table in onchain db with parameters leftId=2 rightId=1 insurance=5000 and ondelta=5000. Also 2's account nonce is bumped by 1 to prevent replay attacks.

Note that `ondelta` is a special field that helps to move the delta onchain. 

**Delta is the delimiter that intuitively says who owns what.** Everything to the left of delta belongs to left user, to the right to right. 

You only touch ondelta when you deposit/withdraw **from the left user**. When you deposit/withdraw from the right side of the channel, you just do the action to insurance only. See delta_demo in `fairlayer/demos` repo if that's unclear. 

## Insurance is ready

Now all nodes, hub #1 including, have an insurance object in their onchain database that says "user 2 has 5k in deposit to user 1". 

Since the ondelta is 5000 and offdelta is still 0 (the default), all those 5k can be redeemed and taken back by the 2nd user by starting an onchain dispute. Note that unlike Lightning we do not need any funding tx and can simply start the dispute without any signed proof which would automatically assume the default state (offdelta = 0 nonce = 0).

![/wiki/step2.png](/wiki/step2.png)


## Our first offchain payment

Things are getting complicated, right? Let's start with most basic direct offchain payment: 2 pays $10 to 1 (hub) unconditionally.

**Offchain payments are all about moving offdelta**. Moved offdelta means moved delta (delta = ondelta + offdelta) which means different dispute outcome. 

The fact that you own signed offdelta (dispute proof) with highest nonce gives you strong confidence that you own the money as you can start a dispute and take them back to your onchain balance.

To see full payment channel protocol look under `offchain/*` files, but in a nutshell user 2 now creates a Payment object in **their offchain database (private)** that has amount=$10, destination=1 and is ready to execute.

The code triggers `flushChannel(user 1)` that finds all pending payments. It creates a transitions object that contains all actions we are doing to our state.

Transition message looks like this:

* asset id we operate with
* ackSig (the signature of the last known state, in our case it would be default offdelta=0 state)
* array of transitions to perform with the state, each transition is [method to perform, arguments, sig of the resulting state]
* debug (optional) - contains our own original state, our final state, our last signed state just to see any discrepencies in states during debugging.

In production, the state itself is never sent. All nodes exchange is arrays of transitions each having an action to do and a resulting signature. Both nodes are supposed to end up with equally deterministic states anyway.

Let's say we send just one transition that says "reduce offdelta by $10" which would effectively move delta to the left from 5000 to 4990.

User 1 now holds a signed proof that means they own $10 in the channel and are guaranteed to be able to claim them. Now user 1 must return same signed message with valid ackSig and no transitions to acknowledge the acceptance of new state (so both users hold the signature for the same state).

![/wiki/step3.png](/wiki/step3.png)


## Mediated transfers

We definitely do not want users to open a lot of channels. Any onchain operation is super expensive (by design), so we expect an average user to have 1-10 channels with hubs that they are using the most (that operate in the areas they live or do business in).

Now let's try to pay 2 -> 1 -> user 123 (the coffeeshop). Let's say #123 is a new user and just installed our wallet. By default it would open a credit limit of $1000 to the @main hub.

User 2 sends a transition "move offdelta by -10 under a condition that you pay to user #123" with a hashlock. Read the separate chapter on hashlocks as they are just too complicated to elaborate here.

The hub sends same transition to user #123 (who they have open websocket with) where they move offdelta (the direction depends on who's left user in 123@1 channel). Let's say #123 is the right user.

After hundreds or thousands of offchain "coffee" payments we end up with #2 user spending $1000 and #123 earning that $1000 (forget about hub fees for now).

123 still does not exist onchain, and there is no collateral locked in between 123 and 1. Which means all $1000 are uninsured.

![/wiki/step4.png](/wiki/step4.png)


## Bad hub: enforceable uninsured balance

**Let's assume our hub tries to censor 123 specifically**, making their channel essentially worthless.

If they had an insurance locked up, they would be guaranteed to take the money after a dispute. But since they aren't, lets say they ask some other user to register them and deposit initial $10 on their onchain balance (needed to make onchain tx to start a dispute).

After a dispute period the blockchain sees that 123 is an honest user and based on resulting delta (0 -1000 = -1000) assigns a Debt object on the hub #1. The debt says "take 1000 FRD from the hub as soon as they get any assets and deposit them to onchain balance of 123".

**Therefore the hub cannot censor a specific user** and this is the major reason why Fairlayer is created as a separate blockchain and not written on top of Bitcoin's LN. This enforceability is the most important difference between [**uninsured** and **trusted** balances.](/wiki/4_four_balances.md)

## Good hub: rebalance

Knowing that all disputes and debts are public, and all users in the world would immediately see the misbehavior of hub 1, the hub has a more sustainable business being a good actor and doing a rebalance.

During a periodic check hub looks up who is riskying the most. 123 has $1000 in uninsured balance and it's time to insure them. But the hub has no assets/liquidity on their own! (Fair hubs do not require any collateral to operate unlike LN hubs).

Thus they must withdraw the insurance from users that are net-spenders, such as our #2 user where the hub owns $1000.

In practice there would be thousands of net-spenders and thousands of net-receivers, so a few net-spenders going offline wouldn't be a big deal. But let's assume our #2 user decides to become malicious and refuses to give withdrawal proof: then the hub starts a dispute using their last dispute proof, waits for delay period, and gets the $1000 on their onchain balance from the channel. #2 is motivated to also be a good actor (and be online regularly) because they would lose in fees and their channel would be destroyed (and they would get $4000 back to #2 onchain balance).

After getting a valid withdrawal proof from #2, the hub crafts a batch that looks like:

* setAsset = FRD (choose an asset to operate in)
* withdrawFrom - array of withdrawals with signatures and amounts
* depositTo - array of deposits with amounts and destinations. giveTo=1 withPartner=123.

Note that the hub must rebalance to `1@123` not to `123@1` because the hub is trying to insure the uninsured and must deposit **from hub's side of the channel**, not just to give new insurance unconditionally.

![/wiki/step5.png](/wiki/step5.png)


## Rebalance being executed

Now after thousands of instant offchain transactions that no other node knows about the whole world gets broadcasted a compact rebalance tx that takes $1000 in insurance from 2@1 and deposits it to 1@123 (also commonly referred as red colored `1000 from 2` and green colored `1000 to @123` accordingly in our blockchain explorer).

Each node verifies the withdrawal signature against 2's public key and other params (leftid/rightid/asset id), bumps the withdrawal nonce on insurance record (replay attack mitigation again), takes $1000 from the `insurance` (note that `ondelta` is untouched as we operate with the right user) and deposits to 1 onchain balance, and then `depositTo` clause makes a deposit to left user 1 in channel with 123. Meanwhile there are some fees being spent for registring 123 onchain account.

When we are making a deposit to left user we must do the same change to `ondelta` since we cannot atomically update signed offdeltas, and we change the onchain part of delta to "balance it off".

Also tiny part of the rebalance to new users goes to their onchain balance for their own safety, because it's required to make an onchain tx.

![/wiki/step6.png](/wiki/step6.png)

## Recap

Finally both users are 100% insured and have same security as a Bitcoin balance, the hub made nice fees from thousands offchain payments, and the world processed only 2 tiny transactions: the initial deposit by 2 and the rebalance by hub 1!

The more scale the network gets, the more value-efficient and compact rebalances will get.

Same logic is applied to any other asset, just the asset_id stored in dispute and withdrawal proofs would be different.

## Direct rebalance (aka "splicing")

Remember that the credit line 123 to 1 is hard capped at $1000? What if 2 wants to send large amount $3000 to 123 (or to their own onchain balance)? Sometimes it would be possible offchain (with streaming), but let's say the capacity is exhausted. Now it's possible to do the same thing like rebalance but in reverse order.

1. 2 asks hub 1 nicely for $3000 withdrawal proof. (Can start a dispute if #1 is unresponsive)

2. Crafts a batch transaction with depositTo: 123@1

3. Insurance in 123@1 is increased by 3000 and ondelta is untouched. Now 123 owns 3995, all insured.

The more withdrawals and deposits you combine in a single tx, the less fee per user you will be paying.

# [Home](/wiki/start.md)
