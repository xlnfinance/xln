# Extended Lightning Network (XLN) and Fairlayer 

## Abstract

In this document we're going to propose a concept and its implementation: a non-opinionated Layer2 scalability technique for blockchains **Extended Lightning Network (XLN)** and opinionated two-layered payment network **Fairlayer**, which is the first blockchain to implement XLN out-of-box.

The novelty of XLN idea is extending the original Lightning Network with credit lines on both sides of a payment channel to solve (or at least significantly alleviate) the capacity problem of LN (the requirement for locking up funds). With credit lines the capacity problem of payment channels is shifted from onchain defined to trust/risk-defined. We believe a payment with higher risk involved is better than no payment at all, which is a common problem with original Lightning.

Fairlayer, on another hand, is a quite opinionated XLN implementation that aims to fix other issues with blockchains other than just scalability. Some parts of Fairlayer such as Proof-of-Authority can come off as controversary, but bear in mind XLN (the generic scaling concept) can be immitated on top of Bitcoin and most of other blockchains albeit in a much more limited fashion than Fairlayer does it.

Our paramount priority is security and censorship resistance even from validator majority, which is why we require absolutely all nodes including consumer devices to be fully-verifying nodes. Thankfully, our full node is designed to routinely run on everything from cheap smartphones to cloud servers and the first "Fair" layer is cheap to keep up with.

**This is the reference client** and no formal specification is planned. If you want to learn how something works just look into the code.

Fairlayer is developed entirely as an end-to-end solution having a full-node, layer2 protocol and default wallet all under one roof working seamlessly. Isomorphic codebase covers different use cases: a wallet, an explorer, a hub and a validator node. 


# FAQ

## Why should I bother? What's your killer feature?

Scalability. Indeed, there are tons of new blockchains these days that claim to be scalable, but almost all of them compromise security and decentralization, increase the blocksize and create a set of high-tps authority nodes that do all the processing for you.

Fairlayer is drastically different. Everyone is a full node, and all payments are taken to the second layer (offchain), which has infinite scalability. 

The second killer feature is our focus on stable coins. We believe the commerce will never embrace volatile assets such as Bitcoin, **that's why Fair Dollar can make you feel like you are using Paypal**, except the fees are 30-50x times lower and there are no chargebacks.

## Infinite scalability? Must be a buzzword

No, it really is nearly infinite and can replace all world value transfers: credit card networks + wire transfes + cash + stock exchange operations etc.

All hubs are uncoupled from each other and only share same settlement layer. Capacity of settlement layer does not dictate the capacity of offchain layer, it only impacts the average Total Risk in the system (sum of all uninsured balances).

Thousand hubs with 1k tps = 1M tps, 1 million hubs with 10k tps each = 10 billion tps, and so on. You can always simply optimize the hub software/hardware or just add more granular hubs for a specific geographic area, e.g. hub for USA, hub for New York, or hub covering Brooklyn. Hence, "infinite" linear scalability.

**Fairlayer can technically survive with 1 onchain transaction per minute**, but the Total Risk will be very high.

That's why one way or another Fairlayer is guaranteed to scale to all world transfer giving more security than traditional banking, and our job is simply to reduce the Total Risk with different techniques.

## Is it a new cryptocurrency?

Not really. It's a decentralized platform on top of which you can create your own [crypto]currencies or other tokens (we call them digital assets). **All Fair assets can be deposited into hubs and sent instantly through the network of payment channels**. There are two native assets created at the genesis and managed by the foundation: [FRD (dollar) and FRB (bet)](https://medium.com/fairlayer/invest-in-fairlayer-pre-ico-95f53bb0351d). FRD is also required to pay for onchain tx fees.

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

More than that, as history shows, onchain governance and software upgrades are inevitable. Traditional software upgrades are centralized (Github releases published by a single person, for example) and prone to compromise.

**That's why in Fairlayer any functionality upgrade is implemented through "smart updates" aka onchain governance** - a set of description, code and patch which validators can vote for.

Smart updates are written in the native language (Javascript), they are easy to read & code and they have no VM overhead. They are a lot more powerful than a virtual machine, they can introduce a new database, a new native binding or, well, they can add a virtual machine for smart contracts too if validators ever decide it's time.

All upgrades, even as simple as changing the color of a button, are delivered through onchain governance for integrity & security.

## Where is the catch? There must be a trade-off!

![/wiki/risktriangle.jpg](/wiki/risktriangle.jpg)

Like mentioned early, Fairlayer introduces a concept of **uninsured balances** which has similarities with fractional reserve. 

Note, that uninsured balance is enforceable unlike trusted/custodian balance [(see a chapter on 4 types of balances to learn more)](/wiki/4_four_balances.md).

That's the balance you have a digital proof for, but the onchain layer does not have locked up collateral for you. Which means the hub **might become insolvent and you will never be able to withdraw your uninsured funds**. There are various techniques such as streaming and rebalances for risk management to reduce uninsured balances. We expect insolvencies and hub compromises to be rare and have contained damages below $1M.

## What consensus it uses?

Currently used consensus engine is Tendermint with Proof-of-Authority used as Sybil protection.

## Everyone is a full node?

Yes, we will never compromise on this property. All laptops and mobile phones must be fully verifying nodes. Light clients don't even exist yet. Onchain layer is very compact and fast to sync.

## Is there an exchange built-in?

There are two types of exchanges. Onchain exchange is perfect for large atomic swaps between Fair assets (see Exchange tab) and is already working. Offchain exchange (through payment channels) is more complicated and will be implemented later. It will have same scalability as centralized exchanges but without the counterparty risk. 

## Can I accept/send Fair assets on my website?

Yes, and it's very easy. You just need to run a local Fair node (takes less than 1 minute to bootstrap a full node) and 10-30 lines of code. [See the chapter on Receive/Pay integration API.](/wiki/9_receive_and_pay.md)


**Feel free to create an issue if you have another question**

# [Home](/wiki/start.md)
