1. Superblocks jump (signatures)

Once in X blocks all validators must create a meta signature for last X blocks which would allow offline clients to sync a lot faster and verify X times less signatures. I.e. for 1000 validators in 1000 blocks now a full node must perform 1 M sig verifications (a pretty expensive operation). With a jump only 1000 checks are needed.

# [Home](/wiki/start.md)
