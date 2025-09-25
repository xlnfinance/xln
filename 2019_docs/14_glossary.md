# Glossary

**address**
Like in Bitcoin, address is where to send money. Encoded string that contains route details: receiver's pubkey and encryption pubkey, banks receiver uses.

**insurance**
The word of choice to explain how many assets are locked between two users onchain. Sometimes referred as collateral or capacity of a channel.

**credit limits**
An explicit trust set by one user to another that allows moving `offdelta` either below 0 or over the `insurance`. `hard_limit` puts the maximum amount the user can accept and `soft_limit` recommends to rebalance after this limit. For example if left (normal user) sets hard_limit=1000 soft_limit=100 to right (bank), the maximum possible delta would be `insurance + 1000` and after reaching `insurance + 100` the bank is supposed to insure the left user.

**delta**
Delta is an intuitive delimiter of a payment channel, and is calculated with this formula: `delta = ondelta (taken from onchain db) + offdelta (taken from dispute proof) + unlocked hashlocks for Left - unlocked hashlocks for Right`.
In onchain payments you work with `ondelta`, in offchain payments you modify `offdelta` inside the state channel.
When it's below zero, all insurance goes to the right user plus `-delta` in uninsured. When `0 < delta < insurance`, `delta` goes to the left user and `insurance-delta` to the right. When it `delta > insurance` all insurance goes to the left user and the rest `delta - insurance` is in uninsured.

**bank**
A centralized entity that routes payments instantly in an atomic and non-custodial fashion. You can think of it as bank 2.0 because it cannot steal your money and you always have a dispute proof to enforce and withdraw your assets. Banks can have channels with other banks which would resemble existing banking sector with nostro/vostro (minus the central banks).

**dispute proof**
In a bidirectional payment channel both parties send each other sets of transitions that modify the state. This state is signed dispute proof. It is only sent onchain when there is a misbehavior by some party, otherwise they are stored privately as last resort. When all parties are honest only withdrawal proofs are used.

**withdrawal proof**
An explicit "cooperative" concent by another party in a payment channel to withdraw some amount of `insurance` from the channel. The user must be online to give you their withdrawal proof. Must have an incremented nonce. Note that this does not "mutually" close the channel like in LN, it simply allows to withdraw from the channel and perhaps send it somewhere else (splicing).

**payment channel**
You can think of it as a banking deposit where both parties have signed proofs and there's well defined protocol for moving funds atomically, plus the channel has optional insurance that can back balances.

**rebalance**
A periodic onchain transaction all banks must send once in a while that withdraws insurance from net-spender and deposits to net-receivers.

**net-spender**
A node whose "insured" balance is lower than its "insurance", i.e. they spent assets an part of the insurance now belongs to the bank. Depending on the size of this part and onchain capacity, net-spenders should come online often to give the bank mutual withdrawal proof, otherwise a dispute will be started against them.

**net-receiver**
Nodes whose "uninsured" balance is above 0, i.e. the bank promised them assets without underlying insurance for them. Eventually when your uninsured balance hits your soft_limit the bank is supposed to rebalance and insure you. Otherwise you can start a dispute and enforce it on the bank.

**hashlock**
An array of conditional clauses inside the dispute proof that says "if left/right you are able to show preimage to HASH before block EXP, left/right user gets AMOUNT". Essentially they work like "hold" money and are in superposition until settled. Left hashlocks increase delta (move it to the right), and right hashlocks move it to the left (once unlocked). There is `K.max_hashlocks` that limits total number of hashlock inside single balance proof.
