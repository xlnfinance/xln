# Rebalances

The job of hubs other than connecting its users is to ensure the lowest total risk (TR) possible.

TR is a sum of all uninsured balances around a hub. TR of $100k means in worst case scenario when the hub is compromised, the attacker is able to withdraw up to all possible $100k from the channels where hub owns assets and send it to attacker's account. That would create an insolvency of $100k. After that all the promises given by the hub in uninsured balances simply cannot be fulfilled anymore, as the funds that were supposed to be used in rebalance are lost.

Note that unlike LN, in XLN we do not require hubs to hold any collateral preloaded in user channels. Instead, each user acts as a liquidity provider that takes a fraction of a risk that hub compromise entails. 

In other words we just replace the unreasonable risk model of LN "hub eats all the damage and hub can only lose their own assets" to "some users lose uninsured parts of their money, hub loses reputation and future profits".

This problem is basically a textbook **"insolvency" of fractional reserve** long known in traditional finance. However, in Fairlayer only tiny part of the balances are uninsured, so the total damages are much less destructive. Our goal is to keep TR of any hub at any time below $1M. 

So the job of rebalance is to ensure at any time the user has as lowest uninsured balance as possible. The hub must periodically withdraw money from the channels where hub owns money (net-spenders) and deposit it to the channels with highest uninsured balances (net-receivers).

**Rebalance is initiated by the end users who explicitly** (with press of a button Request Insurance) or inexplicitly (via soft_limit) tell the hub it's time to insure the uninsured balances. Say, Shop1 has $150 in uninsured, Shop2 $400 and Shop3 $1000. Which means hub must get $1550 from somewhere to insure those (the hub does not have personal funds).

It's up to a hub to decide from which channel it wants to withdraw. The simplest way is to sort by amounts hub owns and select the biggest ones above K.risk. E.g. the hub owns $800 with Alice, $800 with Bob and $56 with Carol, $2 with Ingrid.

![/wiki/spenderstoreceivers.png](/wiki/spenderstoreceivers.png)

In this scenario the hub makes only two requests to Alice and Bob to request a mutual withdrawal proof "the nice way". The amounts with Carol and Ingrid are too small so the hub doesn't touch them.

If Alice or Bob are unresponsive or gone offline, the hub can start a dispute onchain to claim those $800+$800. However it's in everyone's interest to avoid disputes as they are delayed, expensive and the channel stops working. So Alice and Bob return the signatures with withdrawal nonce increased.

Now hub has accumulated $1600 in withdrawals, $1550 in deposits, and broadcasts a single batched onchain tx which roughly looks like:

```
[
  "batch",
  nonce...
  ["withdrawFrom", [[$800, "Alice", AliceSig], [$800, "Bob", BobSig]]]
  ["depositTo", [[$1000, Hub, Shop3],[$400, Hub, Shop2],[$150, Hub, Shop1]]]
] 
```

After this transaction insurances with Alice and Bob are reduced by 800 and increased for shops accordingly. Effectively during the rebalance hub must deposit to its own side of a channel: `hub@user` not to `user@hub`. Because this way the uninsured balances turn into insured, while with user@hub the user would simply get increased insured keeping uninsured value intact.

Also note, before executing depositTos, the blockchain ensures hub has no Debts on it, and pays them first if any. 

## Smarter rebalance

Initially rebalance heuristics will be very simple. Over time we will employ much more sophisticated algorithms for matching net-spenders (to take insurance from) and net-receivers (to deposit insurance to). 

* For instance we could be checking not the immediate channel state but an average state over last 10 days and use machine learning to predict where uninsured balance will go up.

* Have online-presence patterns to get withdrawal proofs from net-spenders earlier than actual rebalance happens

* Optimize for lowest tax paid yet highest volume rebalanced

* 

Those tricks would allow the hub to be more effective, present lower TR for its user base and therefore be more profitable.



# [Home](/wiki/start.md)

