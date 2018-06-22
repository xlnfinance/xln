
Things Fair layer does differently then other blockchains

1. No address as hash(pubkey)

All pubkeys are registered in internal onchain relational DB (currently SQLite) in "users" table with "pubkey" BLOB field (see `db/offchain_db.js`). Commonly hash of pubkey is rationalized as:

* being shorter - our primary id is 3-4 bytes which is a lot shorter than 20 bytes address.

* being quantum secure - it's true that the pubkey is unknown until you use it, but we gain nothing from it today. Even assuming quantum computers (which are very far away), hashing pubkeys will not protect from forged transactions if the forgery process takes less than 1 hour.
