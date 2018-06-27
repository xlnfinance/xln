<img src='https://imgur.com/VksHmn2.jpg' />

[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier)

# Intro

Fairlayer is a new scalable blockchain platform that implements next-gen Lightning [XLN](https://medium.com/fairlayer/xln-extended-lightning-network-80fa7acf80f3) layer2 out-of-box. XLN fixes the liquidity problem - Fairlayer state channels support transfering beyond the capacity/insurance according to credit lines that nodes can set to each other, which induces manageable risk and makes offchain payments more routable.

Fairlayer has no virtual machine for smart contracts, instead uses onchain governance and amendments to implement new functionality.

There are two native tokens FRD and FRB, plus everyone can create their own asset on top of the platform.

Unlike "fake" bloated blockchains with high tps, in Fairlayer the tokens are transfered instantly offchain through the hubs and hubs are responsible for rebalancing "insurances" onchain to reduce the collective risk over time. This allows unlimited transactions per second with a hub-and-spoke topology of hubs. Not 100k tps, not 300k, not 1M, it is in fact unlimited.

It is the same how the Internet topology looks like, and it has no central point of failure.

### [For documentation go to our in-repo Wiki](/wiki/start.md)