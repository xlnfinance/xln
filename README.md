# Failsafe Network

Failsafe is a new blockchain that comes with offchain layer out-of-box - inspired by Lightning and Raiden. The only change we've done is the fix to the liquidity problem - our state channels support transfering promises beyond the collateral (insurance) peers have in a channel onchain, which induces manageable risk and removes scalability caps.

Failsafe has no virtual machine for smart contracts and instead uses onchain governance and consensus amendments.

Failsafe has a native token Failsafe Dollar to pay for transaction fees and hub fees for transfer mediations, but otherwise we aim to support 3rd party issued tokens (just like issuances in Ripple) and uses native currency FSD to pay fees. 

Our final goal is to move bank-backed and government-backed fiat currencies to our blockchain which ensures fairness and security of first layer yet providing all the needed controls and introspection for financial institutions to remain compliant.

Unlike "fake" bloated blockchains with high tps, in Failsafe the tokens are transfered instantly **offchain through the hubs** and hubs are responsible for rebalancing "insurances" onchain to reduce the collective risk over time. **This allows infinite scalability - 1,000,000+ transactions per second with a hub-and-spoke topology of hubs.** It is the same how the Internet topology looks like, and it also has no central point of failure.

You can think of it as FDIC insurance, but not up to a specific amount of $250k - instead it can be any user-chosen amount, and the rules are enforced by the blockchain instead of the government. You can always enforce and take your money from one hub and send to another.

## Roadmap

* Payments is our priority. Implement SDKs for all major payment platforms and shops.

* Now supports single asset FSD. Start supporting flexible asset creation and tokens by 2019

* Now supports single hub. Introduce hub creation by anyone and multihub network by 2019

* All payments are not hashlocked now (the hub is trusted mediator). By 2019 support hashlocks for high-value transfers.

* Asset exchange (fully trustless and atomic offchain swaps) by 2020


## Simnet

Look into `simulate` and install ttab for convenient debugging. 

Basically it creates new root member and copy-paste the folder into 8001, 8002 etc, folder name is the port for convenience. 

Latest Node.js is a must.

## What is it? Docs?

See <a href="https://github.com/failsafenetwork/failsafe/wiki">Wiki</a>

