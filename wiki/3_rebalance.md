# Rebalances

The job of hubs other than connecting its users is to ensure the lowest total risk (TR) possible.

TR is a sum of all uninsured balances around a hub. TR of $100k means in worst case scenario when the hub is compromised, the attacker is able to withdraw all possible funds from the channels where hub owns assets and send it to attacker's account. After that all the promises given by the hub in uninsured balances simply cannot be fulfilled anymore, as the funds that were supposed to be used in rebalance are lost.

This is basically a textbook "insolvency" of fractional reserve long known with traditional banks. However, in Fairlayer only tiny part of the balances are uninsured, so the total damages are much less destructive. Our goal is to keep TR of any hub at any time below $1M. 

So the job of rebalance is to ensure at any time the user has as lowest uninsured balance as possible. The hub must periodically withdraw money from the channels where hub owns money (net-spenders) and deposit it to the channels with highest uninsured balances (net-receivers).

Rebalance is initiated by the end users who explicitly (with press of a button Request Insurance) or inexplicitly (via soft_limit) tell the hub it wants to be insured. Say, Shop1 has $150 in uninsured, Shop2 $400 and Shop3 $1000. Which means hub must get $1550 from somewhere to insure those (the hub does not have personal funds).

It's up to a hub to decide from which channel it wants to withdraw. The simplest way is to sort by amounts hub owns and select the biggest ones above K.risk. E.g. the hub owns $800 with Alice, $800 with Bob and $56 with Carol, $2 with Ingrid.

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

In a long term it's possible to employ much more sophisticated algorithms for net-spenders to take insurance from and net-receivers to deposit insurance to. For instance it could be not an immediate channel state but an average state over last 10 days or some kind of machine learning to predict where uninsured balance will go up in the nearest future the most. 

Those tricks would allow the hub to be more effective, present lower TR for its user base and therefore be more profitable.




