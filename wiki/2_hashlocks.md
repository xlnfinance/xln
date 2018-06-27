# Hashlocks

_Channels are complicated. Channels with hashlocks are even more so._

The main benefit of offchain scaling is ability to instantly send money at almost no cost between 2 parties. But, since you cannot have a channel with everyone else, we must utilize the network of channels.

Original Lightning has proposed a mesh network that would somehow magically route and rebalance itself, but we've not seen it come to true. Fairlayer **may** be used in a mesh-network fashion, but we know for sure centralized hubs are inevitable.

The problem it creates is how do we do the transfer from Alice to Hub then Hub to Bob in a trustless manner? Hub can easily take the money from Alice and never forward it to Bob. We need an in-protocol enforcement for passing the payment forward. 

Lightning proposed a solution based on Hashed Timelocked Contracts (HTLC, but we call them hashlocks for simplicity). 

## Hashlock construction

Hashlocks is a condition/clause which can be satisfied by having an unlocked secret in the blockchain state. Hashlocks consist of [amount, hash, expiration]. Currently we use `sha256` as hashing alg.

Two arrays of hashlocks are added right into dispute proof, i.e. they are directly signed as part of the state. The first array has inward hashlocks for Left user, and the second for Right user.






# [Home](/wiki/start.md)




