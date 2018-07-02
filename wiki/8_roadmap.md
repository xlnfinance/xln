# Tech Roadmap

## Genesis (Q3 2018)

Centralized.


## Asset creation


## Web and mobile wallets


## Hub creation

By this time, we are supposed to have enough data based on usage of @main hub.


## Decentralization: 2/3+ of shares are distributed



## New wallet/hub implementation






Some features that would be nice at some point in the future (deployed via smart updates).

1. Superblocks jump (signatures)

Once in X blocks all validators must create a meta signature for last X blocks which would allow offline clients to sync a lot faster and verify X times less signatures. I.e. for 1000 validators in 1000 blocks now a full node must perform 1 M sig verifications (a pretty expensive operation). With a jump only 1000 checks are needed.

2. Watchtowers (to watch chain and finish a dispute on your behalf)

3. Backup servers that store your encrypted channel db (free/for a fee)


4. Atomic Multipath Payments

5. Fair Names (like ENS and Namecoin. Ensure protection from name squotting via oracles)

6. Fair Login: return signed login token derived from the seed

7. Sharding (per asset): each full node subscribes to specific assets and only receives this asset related rebalances/disputes etc.

# [Home](/wiki/start.md)
