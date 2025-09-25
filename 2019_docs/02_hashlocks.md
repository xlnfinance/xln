# Hashlocks

_Channels are complicated. Channels with hashlocks are even more so._

The main benefit of offchain scaling is ability to instantly send money at almost no cost between 2 parties. But, since you cannot have a channel with everyone else, we must utilize the network of channels.

Original Lightning has proposed a mesh network that would somehow magically route and rebalance itself, but we've not seen it come to true. Fairlayer **may** be used in a mesh-network fashion, but we know for sure centralized banks are inevitable.

The problem it creates is how do we do the transfer from Alice to Bank then Bank to Bob in a trustless manner? Bank can easily take the money from Alice and never forward it to Bob. We need an in-protocol enforcement for passing the payment forward.

Lightning proposed a solution based on Hashed Timelocked Contracts (HTLC, but we call them hashlocks for simplicity).

## Hashlock construction

Hashlocks is a condition/clause which can be satisfied by having an unlocked secret in the blockchain state (there's a registry for preimages store temporarily, inspired by Sprites). Hashlocks consist of [amount, hash, expiration]. Currently we use `sha256` as hashing alg.

Two arrays of hashlocks are added right into dispute proof, i.e. they are directly signed as part of the state. The first array has inward hashlocks for Left user, and the second for Right user.

![/img/proof.png](/img/proof.png)

## The process

## Zero-risk Streaming

In the perfect condition everyone has the balance equal to their insurance, and no uninsured balances. For some types of payments e.g. salary or rent it is possible to set a pending payment that only will be executed once you receive some money. This way we can achieve zero risk - not having uninsured balances even for a second.

Alice sends Bob $100. Bob does not immediately return unlocked hashlock and passes over this $100 payment to Carol, while Carol also passes it to Rental Agent immediately. Rental Agent has no "streams" set up so they unlock their hashlock, then Carol unlocks for Bob's transfer and Bob for Alice. Effectively Alice sent $100 straight to Rental Agent not introducing "risk" (uninsured balances) anywhere in between.

It's also possible to first accept the payment and the second later stream it, and this sub-second risky balance is highly unlikely to be exploited by the bank.

# [3. Rebalance](/03_rebalance.md) / [Home](/README.md)
