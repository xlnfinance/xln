## Other differences

These are other small details that Fairlayer provides by convention as the best practice.

## 1. No address as hash(pubkey)

All pubkeys are registered in internal onchain relational DB (currently SQLite) in "users" table with "pubkey" BLOB field (see `db/offchain_db.js`). Commonly hash of pubkey is rationalized as:

* being shorter - our primary id is 3-4 bytes which is a lot shorter than 20 bytes address.

* being quantum secure - it's true that the pubkey is unknown until you use it, but we gain nothing from it today. Even assuming quantum computers (which are very far away), hashing pubkeys will not protect from forged transactions if the forgery process takes less than 1 hour.

## [2. Snapshots for fast bootstrap](https://medium.com/fairlayer/snapshots-the-simplest-way-to-increase-number-of-full-nodes-3ebf2aaef515?source=collection_home---6------7---------------)

## [3. Uses Strong Brainwallet instead of inconvenient paper backups/seed files](https://medium.com/@homakov/why-brainwallet-are-great-for-cryptocurrency-ff73dd65ecd9)

## [4. Decentralized install via hashed visually-verifiable install snippets](https://medium.com/@homakov/fixing-security-of-software-downloads-with-second-root-of-trust-77f4636d572)

## [5. Optimized for fast sync on a consumer device.](https://medium.com/@homakov/weekly-sync-friction-the-most-important-blockchain-security-metric-1042c0c172b7)



# [Go to Table of Contents](/wiki/0_home.md)
