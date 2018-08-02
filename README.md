[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier)

<img src='/wallet/img/shot.png' />

# Intro

Fairlayer is a billion+ transaction per second payment network secured with blockchain. It implements the idea of Extended Lightning Network [XLN](https://medium.com/fairlayer/xln-extended-lightning-network-80fa7acf80f3).

It is **very easy to be a full node** because it processes few publicly broadcasted onchain transactions (insurance rebalances, disputes etc). All the payments happen instantly offchain and can be enforced in onchain "court" when needed.

# Installation

This repo contains generic code not attached to any network, by design. Use `./simulate` to start local private network.

For existing public network, go to a validator website and find Install page ([https://fairlayer.com/#install](https://fairlayer.com/#install)). This will use latest state and latest code automatically.

When you install on a server, pass `-s/--silent` to switch off `opn` that tries to open a browser with the wallet for you. The script will simply output the URL with auth_code you need to visit.

[For full documentation go to wiki](https://github.com/fairlayer/wiki)

**Hiring Node.js programmers to join full-time: contact info@sakurity.com**
