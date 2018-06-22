# Extended Lightning Network and Fairlayer 

## Abstract

In this document we're going to propose a concept and its implementation: a non-opinionated Layer2 scalability technique for blockchains **Extended Lightning Network (XLN)** and opinionated two-layered payment network **Fairlayer**, which is the first blockchain to implement XLN out-of-box.

The novelty of XLN idea is extending the original Lightning Network with credit lines on both sides of a payment channel to solve (or at least significantly alleviate) the capacity problem of LN (the requirement for locking up funds). With credit lines the capacity problem of payment channels is shifted from onchain defined to trust/risk-defined. We believe a payment with higher risk involved is better than no payment at all, which is a common problem with original Lightning.

Fairlayer, on another hand, is a quite opinionated XLN implementation that aims to fix other issues with blockchains other than just scalability. Some parts of Fairlayer such as Proof-of-Authority can come off as controversary, but bear in mind XLN (the generic scaling concept) can be immitated on top of Bitcoin and most of other blockchains albeit in a much more limited fashion than Fairlayer does it.

Our paramount priority is security and censorship resistance even from validator majority, which is why we require absolutely all nodes including consumer devices to be a fully-verifying nodes, Spv. Thankfully, our full node is designed to routinely run on everything from cheap smartphones to cloud servers and the first "Fair" layer is cheap to keep up with.







## 1. Digital signatures and balance proofs



. The core security principle is **everyone runs a full node** on their devices, with **cheap consumer-grade laptop with world average connection** (8MBit) being primary target




## 1. Understanding the Trust Problem

Central authorities are bad.

## 2. Building Basic Distributed Ledger 

Tendermint PoS.

## 3. Going Off-chain with Simple Payment Channel



## 4. Network of Payment Channels

## 5. Hashlocks

## 6. Fixing Liquidity with Credit Lines

## 7. Mutual Withdrawal and Optimized Rebalances 

7. Reducing Risks Techniques






## 1. Sending to standalone account

Let's start from basic usage. This is on chain database stored on every node:

| Account | On-Chain Balance |
| --- | ---|
| Alice | 10 |
| Bob   | 0 |

In order to transfer 5 to Bob Alice must create a `rebalance` transaction. Rebalance is used in a batch fashion, it has 3 arguments: disputes, inputs, outputs.

We're going to omit first two and focus on outputs. Output is an array with format of `[amount, giveTo, withPartner, invoice]`.

In order to send to standalone balance Alice signs an on chain transaction:

`[id, sig, methodId, nonce, args]`

`id` refers to primary key in accounts database. It takes less space (2-4 bytes) than providing entire 32 bytes pubkey/address.

`sig` is the `ed25517` signature of everything that comes next, the payload.

`methodId` - each onchain tx must have a method that says how the message is interpreted. There's only a handful of them now, so it's normally 1 byte. 

`nonce` - each valid tx increases nonce by one to prevent replay attacks.

`args` - here is the array of `[disputes,inputs,outputs]` which in our case would be `[[],[],[5,BobId,0,0]]`.

As you can see the giveTo is equal Bob's id but withPartner is empty. That's because we haven't touched the payment channels yet.

So the blockchain finds `u=User.findById(BobID)`, increases `u.balance += amount` and deducts from the `signer.balance -= amount`.

Fairly simple. That's how all blockchains function right now: a user broadcasts public transaction, everyone takes it from user's balance and deposits to target, on every single ledger.

That leads to a lot of unnecessary overhead. So in this system we are going to avoid transfers to standalone balances most of the time, because they are too inefficient but provide highest security.

## 2. Sending to a channel

Technically channels are many-to-many relationships between two arbitrary users in the database. However, most of the time one of those users would be a hub. 

So let's say Alice wants to transfer money off-chain through a Hub. She would have to use an output with `[10, AliceId, HubId, 0]` - this means deposit to Alice's part of a channel with Hub. We're going to refer to channels as alice@hub. It's also possible to deposit to hub@alice - that's how hubs rebalance their users. First part denotes user you want to deposit insurance to and second is their partner.

| Left | Right | Insurance | Ondelta
| --- | ---|---|---|
| Alice | Hub |10 |10|

As you can see there is Left and Right users. Left user is the one with lower numerically (Buffer.compare) pubkey.

`Insurance` is like a balance between two users that they can move between each other off-chain.

Finally, another new field is `ondelta`. 




3. Uninsured balance 

```
Alice -> Hub -> Bob
============|  H ===|  $
=========|===  H |===  
=========|===  H ===|===  $
======|======  H |======  
======|======  H ===|======  $
===|=========  H |=========  
===|=========  H ===|=========  $
|============  H |============  


============|  H |  
=========|===  H |---  
======|======  H |------  
===|=========  H |---------  
===|           H |=========  $
|===           H |=========---  
```


