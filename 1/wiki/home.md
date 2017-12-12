# Failsafe - instant decentralized payments

Here's a project I've been working on for last 7 months, and while it's still in quite early stage, I'd like to share details and the prototype to hear some advice.

Failsafe is a combination of different concepts. First and foremost it's the payment network of value transfers anything-to-anything, what Bitcoin wanted to become.

Our vision is to provide decentralization, scalability and stability, with no compromises in any of them.

1) Decentralized (for real)

It's futile to talk about which blockchain is more secure without a clear metric. 

We define decentralization metric through **number of centers** and their hijackability - likeability the majority of them to be hijacked at once due to some sort of event. 

Hijackability is how many entities need to be compromised to take over consensus (to do double spends, to mine empty blocks forever etc).

Proof-of-Work is insecure. It gravitates to centralization, and there's nothing you can do about it. That's now crystal clear. Miracle didn't happen, no one has a "personal miner" under their desk (21.co who tried to build one pivoted to email paywall). Let's move on. Not because of "environmental damage" - because it's in-se-cu-re. 

Now there are 4 miners (all in China) for btc and 2 pools for eth that control 51% of hashrate. Which means that decentralization of btc is 4 and eth is 2, which is just as good as a running a single server with (decentralization == 1.)

Cost-of-attack or nothing-at-stake problems are non-existent and irrelevant. Saying "the attacker must buy hashrate" is like saying "the US gov needs to run a competitor of E-Gold to make it lose all customers".

No - you just hijack existing miners/stakers, and the number of entities to hijack is all that matters.

When consensus is taken over everything is lost, it's a game over. 

Consensus must be engineered to have as many centers as possible, not to pump up imaginary cost of attack. 

Any alternative (e.g. Chia https://techcrunch.com/2017/11/08/chia-network-cryptocurrency/) that's based on computational resources (be it storage, or GPU mining) will also inevitably end up centralized. 

Proof-of-Stake is slightly better, because has more centers, but the main problem remains: the stake can be sold, and the governments have enough money to hijack the big fish and buy enough stake to take over the consensus. That's why consensus must be based on something that can't be bought with just money.

One thing that is not so centralizable is human trust. The network starts with 1000 voting rights, and 999 of them will be distributed before Jan 3 2021. Check this page on how to become a member of the board. Since it's impossible to say that John is more likely to be hijacked than Alice, the rule is 1 person 1 vote. 

All members must be geopolitically distributed, as well as their block signing nodes in the cloud. I.e. 51% of block signers in 1 country means 1 center (that country can take over them all overnight), 51% in different countries yet in single hosting provider (AWS/Digital ocean for example) - still means decentralization of 1. 

Every single aspect from OS, hosting provider, physical location of the server, physical location of the member, citizenship of the member must be decentralized at all time, so no natural disaster force majeure can destroy everything.

You can't call it a permissioned/private/consortium chain simply because anyone can become a member - it's free. Just prove to existing members you're worthy. 

2) Scalability? Solved.

The project started after I looked closely into Lightning Network. I was initially excited by the off-chain p2p channels, but after a few thought experiments realized - it doesn't make any sense. Explained why in this post:

https://medium.com/@homakov/introducing-failsafe-network-ea47ab476fe6


In short, Failsafe fixes that but having some users acting as hubs: other users can have channels to them. We also remove boundaries from the channel capacity, from both sides.

The hub can pay a new user without the collateral onchain, because hub is moderately trusted and chosen by the board. In theory even user can pay without the collateral based on their reputation (good old credit cards), but that's not any time soon.



3) Stability. 

Internal currency is failsafe dollar - equal to 1 USD.

On a high level, Failsafe looks like any bank or Paypal: you deposit money from outside (credit card, banks, etc), you have US$ on your account, you can move them around, and then you can withdraw them to outside (bank account, etc).

The only difference you **own** your money just like you own Bitcoin at all times. Yes, similar to Tether, with only difference that Tether has zero innovation in scalability/decentralization.

Unlike Tether, Failsafe is backed by different value systems and different members. E.g. 5% in Member1 account in Bank1, other 5% in Member2 Bitcoin address, 

Actually, read the whitepaper by theBaseCoin http://www.getbasecoin.com/basecoin_whitepaper_0_99.pdf - which has some ideas about stability measures but still, no innovation in scalability/decentralization.

Failsafe uses a combination of Tether and BaseCoin:

* best effort is taken to back each FSD with a USD in a bank or similar structure somewhere

* if some of the accounts are compromised / seized, the lost part can be paid out with the money coming from failsafe bonds - FS30 - which are issued by the board and on Jan 3 2030 they can be exchanged 1-1 to FSD. 






archiving node: stores all transactions from day one


2. Voting

3. Figuring out metrics of our new government


Figure out when people are dying onchain. Then calculate the average. Set goals for president, if average is too low, auto-revoting.





You are an average blockchain user. You use it rarely, but you're enthusiastic but not that enthusiastic to buy an extra hardware or pay for a dedicated fiber just to stay in sync with the chain.

How many Mb the blockchain adds per every week you wasn't actively syncing, and how long it takes to sync it on World Average Speed https://www.akamai.com/us/en/about/news/press/2017-press/akamai-releases-first-quarter-2017-state-of-the-internet-connectivity-report.jsp (7Mpbs - About one megabyte per second download )?




asset
collateral
settled
withdrawal_nonce


offchain
asset
delta
nonce



real delta = delta - settled 
real balance = collateral + real delta


average real delta = over last week, calculated by clients


offchain delta
onchain delta










PoW is not environmentally unfriendly, it's insecure.



1. USD and assets, hubs, payment channels

2. companies and stock, 4 bytes asset type

3. name service

4. web of trust API






Roadmap

2018

1. create full wiki

2. GUI for regular users

3. GUI for members

4. payment hubs

5. SDKs for all platforms

6. payroll streams

7. multisigs

8. keybase-like verification

9. 3 servers 334, 333 and 333

10. integration with exchanges

2019 

1. name service, usernames

2. allow anyone creating tokens and define common rules (like ERC20)

3. support for Windows and Mobile

4. start 1 or more new hubs by other members

5. roll out new UI







