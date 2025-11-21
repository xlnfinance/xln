# Extended Lightning Network (XLN) and Fairlayer

![/img/risktriangle.jpg](/img/risktriangle.jpg)

## Abstract

0.  old banking is a network of unsigned state channels

1)  XLN

2)  snapshots and hashed install

3)  full node optimization for consumer devices

## Onchain methods

Main XLN functionality is elegantly based around just three methods: `deposit`, `withdraw` and `dispute`.

**deposit** is a transfer from signer's onchain balance to either someone else's onchain balance or to their channel on their behalf. It accepts asset, amount, target id, id of partner (if it's a channel, 0 if it's onchain balance) and an optional invoice.

**withdraw** is a withdrawal from a channel adjacent to the signer, i.e. the signer can only withdraw from channels they participate in. It can be used in a combo with `deposit` to simultaneously withdraw X from your bank and deposit X to bank of the destination if your payment is too large to be sent offchain. It accepts asset, amount, id of your partner in a channel, and a valid signature by your partner that shows their **explicit permission to withdraw** from this channel. This signed withdrawal proof also includes a withdrawal_nonce so it cannot be reused (to exhaust the channel quickly).

The combinations of these two methods are supposed to make up 99% of entire blockchain history. Mostly it should be large batched rebalances broadcasted by banks, with hundreds of withdrawal proofs (from net-spenders) on one side and hundreds of deposits (to net-receivers) on the other side.

Very rarely it would be single-withdrawal single-deposit broadcasted by end-users - this should be done only for large amounts when a direct offchain payment wasn't possible.

Other methods are expected to be used much less.

**dispute** if your partner is unresponsive, ignores you or has gone offline, anyone is free to broadcast their latest signed dispute proof. This will fire up a timer lasting for hours/days to give the partner time to broadcast a counter proof with higher dispute_nonce. If it does not happen, the dispute is resolved automatically and the signer gets the assets to their onchain balance.

Insured assets are returned immediately and guaranteed no-matter-what. It attempts to charge uninsured balance from the partner's onchain balance, but if it's empty a Debt object is created on partner's identity. Once partner gets any assets ever again, your debt will be the first in queue to be paid back (first-in-first-out). If the partner has gone forever, your uninsured assets will never be returned. That's part of the threat model, so request insurance wisely and manage your risk exposure.

In this document we're going to propose a concept and its implementation: a non-opinionated Layer2 scalability technique for blockchains **Extended Lightning Network (XLN)** and opinionated two-layered payment network **Fairlayer**, which is the first blockchain to implement XLN out-of-box.

The novelty of XLN idea is extending the original Lightning Network with credit lines on both sides of a payment channel to solve (or at least significantly alleviate) the capacity problem of LN (the requirement for locking up funds). With credit lines the capacity problem of payment channels is shifted from onchain defined to trust/risk-defined. We believe a payment with higher risk involved is better than no payment at all, which is a common problem with original Lightning.

Fairlayer, on another hand, is a quite opinionated XLN implementation that aims to fix other issues with blockchains other than just scalability. Some parts of Fairlayer such as Proof-of-Authority can come off as controversary, but bear in mind XLN (the generic scaling concept) can be immitated on top of Bitcoin and most of other blockchains albeit in a much more limited fashion than Fairlayer does it.

Our paramount priority is security and censorship resistance even from validator majority, which is why we require absolutely all nodes including consumer devices to be fully-verifying nodes. Thankfully, our full node is designed to routinely run on everything from cheap smartphones to cloud servers and the first "Fair" layer is a breeze to keep up with in background.

**There is only reference client** and no formal specification at the moment. If you want to learn how something works just look into the code, the wiki or ask.

# FAQ

## Why should I bother? What's your killer feature?

Scalability. Indeed, there are tons of new blockchains these days that claim to be scalable, but almost all of them compromise security and decentralization, increase the blocksize and create a set of high-tps authority nodes that do all the processing for you.

Fairlayer is drastically different. Everyone is a full node, and all payments are taken to the second layer (offchain), which has infinite scalability.

The second killer feature is our focus on stable coins. We believe the commerce will never embrace volatile assets such as Bitcoin, **that's why Fair Dollar can make you feel like you are using Paypal**, except the fees are 30-50x times lower and there are no chargebacks.

## Infinite scalability? Must be a buzzword

No, it really is nearly infinite and can replace all world value transfers: credit card networks + wire transfes + cash + stock exchange operations etc.

All banks are uncoupled from each other and only share same settlement layer. Capacity of settlement layer does not dictate the capacity of offchain layer, it only impacts the average Total Risk in the system (sum of all uninsured balances).

Thousand banks with 1k tps = 1M tps, 1 million banks with 10k tps each = 10 billion tps, and so on. You can always simply optimize the bank software/hardware or just add more granular banks for a specific geographic area, e.g. bank for USA, bank for New York, or bank covering Brooklyn. Hence, "infinite" linear scalability.

**Fairlayer can technically survive with 1 onchain transaction per minute**, but the Total Risk will be very high.

That's why one way or another Fairlayer is guaranteed to scale to all world transfer giving more security than traditional banking, and our job is simply to reduce the Total Risk with different techniques.

## Is it a new cryptocurrency?

Not really. It's a decentralized platform on top of which you can create your own [crypto]currencies or other tokens (we call them digital assets). **All Fair assets can be deposited into banks and sent instantly through the network of payment channels**. There are two native assets created at the genesis and managed by the foundation: [FRD (dollar) and FRB (bet)](https://medium.com/fairlayer/invest-in-fairlayer-pre-ico-95f53bb0351d). FRD is also required to pay for onchain tx fees.

## So you promise to redeem FRD for 1 USD?

No, we don't believe in promises. We believe in math and code. **Whenever in doubt - read the code** and make up your own mind. FRD is a new fiat currency and can be "minted" as much as needed, think Australian dollar or Japanese yen. FRB is capped at 100B and is converted 1-for-1 to FRD in 2030. We do not make any promises about price or gains you can make.

## But you do expect FRD to be stable?

Correct. [There were multiple ideas how to create a stable coin.](https://hackernoon.com/stablecoins-designing-a-price-stable-cryptocurrency-6bf24e2689e5). We utilize a hybrid of Tether and Basis approach: the assets are both collateralized accross a wide range of exchanges and bank accounts AND seignorage (FRB) sold to support the peg if there's a compromise in some accounts that hold the collateral.

It is impossible to avoid compromises as currently USD can only exist on top of centralized ledgers and custodian banks, and there's simply nothing we can do to protect the funds other than making our best effort. Whenever a large chunk of collateral is lost we will be selling FRB funds to cover the losses.

## What is the price expectation for FRB?

Since at some point in the future FRB is expected to turn into FRD, its price is expected to start around 0.001 and go up to 0.999999 nearing the maturity date in 2030 (**Unix timestamp 1913370000**). It might hit 0.5 in 2020, or in 2029, or never.

The success of FRB is based on the success of Fairlayer adoption, that's why it's called a "bet". FRB, just like any asset, can be moved instantly via payment channels and sold any time before 2030 to another entity. By the date of maturity all assets must be withdrawn from payment channels to onchain balances.

## Are there smart contracts?

A virtual machine for smart contracts was proposed to solve one simple issue: lack of governance process to upgrade the underlying blockchain. We believe smart contracts such as EVM are too complicated to write secure and sophisticated code, produce too much overhead and limitations (gas limits), have steep learning curve and too little use cases.

More than that, as history shows, onchain governance and software upgrades are inevitable. Traditional software upgrades are centralized (github releases published by a single person, for example) and prone to compromise.

That's why in Fairlayer any functionality upgrade is implemented through **smart updates** (onchain governance) - a set of description, code and patch which validators can vote for.

Smart updates are written in the native language (Javascript), they are easy to read & code and they have no VM overhead. They are a lot more powerful than a virtual machine, they can introduce a new database, a new native binding or, well, they can add a virtual machine for smart contracts too if validators ever decide it's time.

All upgrades, even as simple as changing the color of a button, are delivered through onchain governance for integrity & security.

## Where is the catch? There must be a trade-off!

Like mentioned early, Fairlayer introduces a concept of **uninsured balances** which has similarities with fractional reserve.

Note, that uninsured balance is enforceable unlike unsigned balance [(see a chapter on 4 types of balances to learn more)](/04_four_balances.md).

That's the balance you have a digital proof for, but the onchain layer does not have locked up collateral for you. Which means the bank **might become insolvent and you will never be able to withdraw your uninsured funds**. There are various techniques such as streaming and rebalances for risk management to reduce uninsured balances. We expect insolvencies and bank compromises to be rare and have contained damages below $1M.

## What consensus it uses?

Currently used consensus engine is Tendermint with Proof-of-Authority used as Sybil protection.

## Everyone is a full node?

Yes, we will never compromise on this property. All laptops and mobile phones must be fully verifying nodes. Light clients don't even exist yet. Onchain layer is very compact and fast to sync.

## Is there an exchange built-in?

There are two types of exchanges. Onchain exchange is perfect for large atomic swaps between Fair assets (see Exchange tab) and is already working. Offchain exchange (through payment channels) is more complicated and will be implemented later. It will have same scalability as centralized exchanges but without the counterparty risk.

## Can I accept/send Fair assets on my website?

Yes, and it's very easy. You just need to run a local Fair node (takes less than 1 minute to bootstrap a full node) and 10-30 lines of code. [See the chapter on Receive/Pay integration API.](/09_receive_and_pay.md)

## Are banks and validators different things?

Yes, but some can be both. Validators protect the onchain layer: propose and sign on blocks, and we need a lot of validators with 1 stake each to reduce the risk of a fork (you need to hijack 1/3+ which is 34 validators out of 100).

Banks exist in offchain layer, they mediate transfers and rebalance insurance once in a while. Anyone can start a bank, but to become a validator you need to be elected by current validator majority (2/3+ votes for your node).

Validators are held to a higher standard, they must be well verified, independent and honest: compromised onchain layer is a game over, while broken offchain layer is mere inconvenience.

**Feel free to create an issue if you have another question**

# [1. Channels](/01_channels.md) / [Home](/README.md)
