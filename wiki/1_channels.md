# Payment channels

Payment channels is the cheapest & lowest-latency (1 HTTP request) known way to make a payment without touching the blockchain but still having the security of it. In this chapter we will explain our payment channels protocol, and how it was carefully optimized step-by-step for atomic hashlocks, multiple assets and batched rebalances.

Participants commit a specific state between them to a blockchain to start a channel, then do different actions offchain sending specific proofs directly to each other. If any party cheats or becomes unresponsive, the other party can submit latest state to blockchain and gets a fair result (agreed amount of money)

## Under the hood

All users have payment channels with everyone else by default with `insurance=0` and no payments can happen, so we don't use the term "open a channel". To start paying through a channel Alice must send a tx onchain that deposits `insurance` into the channel with Hub. Since all tx in Fair are batched, this code will create a new deposit.

`batch.push('depositTo', asset, [amountToDeposit, giveTo, withPartner, invoice])`

Let's say asset=1 (FRD), amountToDeposit=$6, giveTo=user id 5, withPartner=user id 7 and `invoice` is empty (this field exists for paying large purchases with direct onchain settlement).

After broadcasting and being included into a block, this onchain tx, just like any other onchain event, must be processed by all full nodes of the blockchain.

**Each node parses** the batch's tx one by one and sees "depositTo" instruction (see `process_tx.js`). It reads the asset id, then deducts the amountToDeposit from onchain balance of `signer` (the user who created this tx), and deposits it to the channel's `insurance` between 5 and 7. We are going to refer to this channel as 5@7, where the first comes is the one from which side you deposit. 

## Left and Right users

For simplicity we want to have deterministic channel where two users can have only one channel per asset. To do that we use `Buffer.compare(pubkey1, pubkey2)` and the one with lower pubkey is called **left user**, and the other one is right.

Let's say 5 happened to have lower pubkey and is left one. How do we deposit to 5@7? This is actual code:

```
ins.insurance += amount
if (compared == -1) ins.ondelta += amount
```

First, we increase `insurance+=amountToDeposit`, the total amount of money locked in this channel as collateral. But then if the user is left we also must do the same thing to `ondelta`.

## Delta = ondelta + offdelta

After finding Lightning's commitment tx and Raiden's balance proofs approach inconvenient for rebalancing, we designed  a simpler approach..

Imagine a x-axis with `.` being 0. 

Then lets draw our `insurance` equal 6 on it, starting from 0 

`.======`

Now let's add delta equal 6 (| means delta). 
 
`.======|`

This visual representation is fairly intuitive: everything from the left of delta separator belongs to left user, and other part to the right. So the 6 insurance `=` bricks now belong to 5, the left user.

Delta doesn't exist anywhere by itself, it is always implied to be sum of `ondelta` and `offdelta`. As it can appear from their names, ondelta is the one stored onchain and modified during onchain withdraws and deposits (rebalances). Offdelta is the one stored in dispute proofs and always modified offchain when you're sending payments instantly. Offdelta is revealed onchain only in case of a dispute between the parties, otherwise it's stored privately.

Since it's a new channel, both offdelta and ondelta are 0, therefore delta is 0. We cannot change offdelta in an onchain tx, so let's move the ondelta part to move the delta to 6 with `ondelta+=6`.

Alright, now the ondelta is 6, insurance is 6 and offdelta is still 0.

## resolveChannel

It's about time to introduce the "cornerstone" function of Fairlayer (the very first function you will find reading the codebase):

```
// This is the most important function in the whole project. Make sure you understand it!
// Defines how payment channels work, based on "insurance" and delta=("ondelta"+"offdelta")
// There are 3 major scenarios of delta position
// . is 0 point, | is delta, = is insurance, - is promised
// 4,6  .====--| (left user owns entire insurance, has 2 uninsured)
// 4,2  .==|==   (left and right both have 2 insured)
// 4,-2 |--.==== (right owns entire insurance, 2 in uninsured balance)
resolveChannel = (insurance, delta, is_left = true) => {
  var parts = {
    // left user promises only with negative delta, scenario 3
    promised: delta < 0 ? -delta : 0,
    insured: delta > insurance ? insurance : delta > 0 ? delta : 0,
    they_insured:
      delta > insurance ? 0 : delta > 0 ? insurance - delta : insurance,
    // right user promises when delta goes beyond insurance, scenario 1
    they_promised: delta > insurance ? delta - insurance : 0
  }

  // default view is left. if current user is right, simply reverse
  if (!is_left) {
    ;[
      parts.promised,
      parts.insured,
      parts.they_insured,
      parts.they_promised
    ] = [parts.they_promised, parts.they_insured, parts.insured, parts.promised]
  }

  return parts
}
```

Try playing around with parameters: understanding of inputs and outputs of this method is paramount to understanding Fairlayer. Let's consider our case

```
 resolveChannel(6, 6, true)
{ promised: 0, insured: 6, they_insured: 0, they_promised: 0 }
```

This is how user 5 sees the channel with 7 right now. We own 6 in insurance, they own nothing.

```
> resolveChannel(6, 6, false)
{ promised: 0, insured: 0, they_insured: 6, they_promised: 0 }
```

And vice-versa, 7 after processing onchain tx, sees that 5 owns 6 in `they_insured`. Please note, we always add `they_` prefix to various values of the counterparty in the channel. 

## Canonical state (dispute proof)

In order to make our first payment, we must figure out the common canonical representation of a state channel. We don't need to bother to use actual onchain tx like they do in Lightning, we also don't want to send always changing balance of the counterparty like in Raiden. All we care about is offdelta.

```

  var state = [
    methodMap('disputeWith'),
    [
      left ? this.myId : this.partnerId,
      left ? this.partnerId : this.myId,
      this.nonce,
      this.offdelta,
      this.asset
    ],
    // 2 is inwards for left, 3 for right
    [],
    []
  ]
```

For encoding of any binary arrays in Fairlayer we use Recursive Length Prefix library. After rlp.encode(state) we sign it and share the sig with the partner.

The first element of the state is `methodMap('disputeWith')`. We always use `methodMap` utility to hop back and forth between a string and it's compact int index to save bytes. The second element consists of metadata: left user pubkey, right user pubkey, nonce (the higher is move valid one), offdelta and asset id.

The other two elements are hashlocks which we will get back to later.

## Offchain Payment

Now both parties know that there's collateral/insurance locked between them onchain, and user 5 can can pay up to $6 to user 7. To do a $3 offchain payment as we noted earlier we move `offdelta` which moves delta to the left and increases ownership of user 7.

`.======|`
`.===|===`

Internally all payments are expressed in flush_channel and update_channel files. Flush channel finds all pending transitions and applies them on the state, then send the request of following format:

```
me.envelope(
      methodMap('update'), // denotes that it is an update message
      asset, // asset id we are operating with
      ackSig,  // a signature of the state that we start from (acks previous transitions if any)
      transitions, // 0 or more transitions: [transition type, transition args, state sig after applying]
      debugState, // DEBUG: state we started with
      r(ch.d.signed_state) // DEBUG:  signed state we started with
    )
```

## Visual Playground

See `/wallet/demodelta.html` to see ondelta/offdelta movements in action.


# [Go to Table of Contents](/wiki/0_home.md)


