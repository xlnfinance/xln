# Rebalances

The job of banks other than connecting its users is to do their best to have lowest total risk (TR) possible.

Since any bank can be hacked any second, they must constantly take insurance from net-spenders and give to net-receivers to reduce the potential damage at any point of time the hack might happen.

TR is a sum of all uninsured balances around a bank. TR of $100k means in worst case scenario when the bank is compromised, the attacker is able to withdraw up to all possible $100k from the channels where bank owns assets and send it to attacker's account. That would create an insolvency of $100k. After that all the promises given by the bank in uninsured balances simply cannot be fulfilled anymore, as the funds that were supposed to be used in rebalance are lost.

Note that unlike LN, in XLN we do not require banks to hold any collateral preloaded in user channels. Instead, each user acts as a liquidity provider that takes a fraction of a risk that bank compromise entails.

In other words we just replace the unreasonable risk model of LN "bank eats all the damage and bank can only lose their own assets" to "some users lose uninsured parts of their money, bank loses reputation and future profits".

This problem is basically a textbook **"insolvency" of fractional reserve** long known in traditional finance. However, in Fairlayer only tiny part of the balances are uninsured, so the total damages are much less destructive. Our goal is to keep TR of any bank at any time below $1M.

So the job of rebalance is to ensure at any time the user has as lowest uninsured balance as possible. The bank must periodically withdraw money from the channels where bank owns money (net-spenders) and deposit it to the channels with highest uninsured balances (net-receivers).

**Rebalance is initiated by the end users who explicitly** (with press of a button Request Insurance) or inexplicitly (via soft_limit) tell the bank it's time to insure the uninsured balances. Say, Shop1 has $150 in uninsured, Shop2 $400 and Shop3 $1000. Which means bank must get $1550 from somewhere to insure those (the bank does not have personal funds).

It's up to a bank to decide from which channel it wants to withdraw. The simplest way is to sort by amounts bank owns and select the biggest ones above K.risk. E.g. the bank owns $800 with Alice, $800 with Bob and $56 with Carol, $2 with Ingrid.

![/img/spenderstoreceivers.png](/img/spenderstoreceivers.png)

In this scenario the bank makes only two requests to Alice and Bob to request a mutual withdrawal proof "the nice way". The amounts with Carol and Ingrid are too small so the bank doesn't touch them.

If Alice or Bob are unresponsive or gone offline, the bank can start a dispute onchain to claim those $800+$800. However it's in everyone's interest to avoid disputes as they are delayed, expensive and the channel stops working. So Alice and Bob return the signatures with withdrawal nonce increased.

Now bank has accumulated $1600 in withdrawals, $1550 in deposits, and broadcasts a single batched onchain tx which roughly looks like:

```
[
  "batch",
  nonce...
  ["withdrawFrom", [[$800, "Alice", AliceSig], [$800, "Bob", BobSig]]]
  ["depositTo", [[$1000, Bank, Shop3],[$400, Bank, Shop2],[$150, Bank, Shop1]]]
]
```

After this transaction insurances with Alice and Bob are reduced by 800 and increased for shops accordingly. Effectively during the rebalance bank must deposit to its own side of a channel: `bank@user` not to `user@bank`. Because this way the uninsured balances turn into insured, while with user@bank the user would simply get increased insured keeping uninsured value intact.

Also note, before executing depositTos, the blockchain ensures bank has no Debts on it, and pays them first if any.

## Smarter rebalance

Initially rebalance heuristics will be very simple. Over time we will employ much more sophisticated algorithms for matching net-spenders (to take insurance from) and net-receivers (to deposit insurance to).

- For instance we could be checking not the immediate channel state but an average state over last 10 days and use machine learning to predict where uninsured balance will go up.

- Have online-presence patterns to get withdrawal proofs from net-spenders earlier than actual rebalance happens

- Optimize for lowest tax paid yet highest volume rebalanced

Those tricks would allow the bank to be more effective, present lower TR for its user base and therefore be more profitable.

# [4. Four balances](/04_four_balances.md) / [Home](/README.md)
