Why did full-reserve state channels fail, really? Dozens of projects tried to implemented original Lightning-style channels. None of them succeeded. Raiden, Connext, Celer, Statechannels.org / Nitro, Spankchain, Perun, even Ripple, Interledger. All of them - dead. Literally zero working and usable networks in 2025. Why?

Three reasons: 
1) the deal breaker: inbound liquidity wall. No new user could receive tokens, no existing users could receive beyond their (very small) pre-allocated limit. That, non-negotiably, was the main reason channels failed. But there are two more!
   
2) lack of general EVM programmability and system-wide composability. Around 2017-2019 main driver of Ethereum growth was Lego Defi: a composable, universal shared state where a new contract could trigger any existing contract, having shared liquidity and enjoying global ABI interfaces interacting with each other within a single Ethereum transaction. Original understanding of channels lacked that: it only supported payments with very little research into swaps and beyond.

3) lack of DAOs and AA (account abstraction) programmability. A single party of a channel

4) A lot of research that was simply unnecessary and focused on the wrong things. No, nobody needs AMP (Atomic Multipath Payments). Virtual Channels (channels on top of other channels) are useless. Multi-party 3+ entities in a channel are simply a waste of time – bilateral 2-of-2 consensus is mathematical optimum. 

xln fixes all three, avoiding 4th. 1) is fixed with RCPAN. Today, let's talk about DeltaTransformer.sol and how it fixes 2) generalized EVM compatibility.

