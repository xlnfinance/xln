## Other differences

These are other small details that Fairlayer provides by convention as the best practice.

## 1. No address as hash(pubkey)

All pubkeys are registered in internal onchain relational DB (currently SQLite) in "users" table with "pubkey" BLOB field (see `db/offchain_db.js`). Commonly hash of pubkey is rationalized as:

- being shorter - our primary id is 3-4 bytes which is a lot shorter than 20 bytes address.

- being quantum secure - it's true that the pubkey is unknown until you use it, but we gain nothing from it today. Even assuming quantum computers (which are very far away), hashing pubkeys will not protect from forged transactions if the forgery process takes less than 1 hour.

## [2. Snapshots for fast bootstrap](https://medium.com/fairlayer/snapshots-the-simplest-way-to-increase-number-of-full-nodes-3ebf2aaef515?source=collection_home---6------7---------------)

## [3. Uses Strong Brainwallet instead of inconvenient paper backups/seed files](https://medium.com/@homakov/why-brainwallet-are-great-for-cryptocurrency-ff73dd65ecd9)

## [4. Decentralized install via hashed visually-verifiable install snippets](https://medium.com/@homakov/fixing-security-of-software-downloads-with-second-root-of-trust-77f4636d572)

## [5. Optimized for fast sync on a consumer device.](https://medium.com/@homakov/weekly-sync-friction-the-most-important-blockchain-security-metric-1042c0c172b7)

## 6. No invalid blocks/tx

The content of a block that has 2/3+ precommits is never verified. Each validator may put into a block whatever they want, even megabytes of nullbytes, only limited by blocksize. In order to maximize profits, they must verify the transactions are valid. If other validators see some validator puts a lot of invalid tx into their blocks, they may vote to remove malicious validator.

## 7. 1 user 1 address

It used to be a common practice to bloat the blockchain with unnecessary throw-away addresses generated per-user. As a result there is a lot of dust for no useful reason. This practice neither gives you strong privacy (the link between UTXOs is apparent once you spend them in batch), nor convenient to deal with as a merchant, and is a nightmare for backup (until mnemonic seeds were proposed).

In Fairlayer we believe onchain space is precious (once again: all nodes are full nodes), and recommend to have just one account onchain per identity, and every payment must include an invoice tag that refers to the motivation of this payment (user id or order id). This invoice is private when sent offchain, and public when rebalanced onchain.

# [8. Roadmap](/08_roadmap.md) / [Home](/README.md)
