# 4 Types Of Balances in Fairlayer

The main theme of Fairlayer is not to force you onto some specific type of balance, but provide a convenient wallet to hop between each type. Onchain balance is great for millions of dollars, terrible for coffee payments. Trusted balance is terrible for millions of dollars, great for paying in subway. 

Insured and uninsured are perfectly positioned in between, both being more secure than trusted and more convenient than onchain.

Let's try to formalize these 4 types of balances we're talking about.

## Onchain Balance

**Security: Highest Possible**

Onchain balance cannot be taken from you under no plausible attack, period. Only a hardfork or onchain governance decision could seize your onchain balance. You can go offline for years and it still will be assigned to your pubkey. Can be assigned a multisig vault (n/m signatures required)

**Usability: Lowest Possible**

Very expensive and slow to send: always requires an onchain transaction and induces high fees. Use it only for money you don't plan to spend for years. 

## Insured Balance (in channel)

**Security: Very High** 

There are few rare corner-cases when you might lose money: when you are offline for long time, the watchtowers fail to broadcast fraud proof and/or validator majority works against you. Other than that security of insured balance is equivalent to security of onchain balance.

**Usability: Medium** 

You can only receive into insured balance if there's charged capacity towards you from the hub, i.e. if you just "spent" on something. Otherwise money will arrive to uninsured balance and will be rebalanced at some point in the future. 

Can be sent/received instantly through the hub. Requires a signature generated on your device (must be online to send)

## Uninsured Balance (in channel)

**Security: Medium**

This is an extension we added to Lightning Network model - simply the ability for delta to go beyond the capacity (insurance). Just like the insured one this balance is signed and can be enforced onchain, however if the counterparty is insolvent/compromised and there are simply no assets to return you, you might lose your money. Uninsured balance is a lot more secure than just a trusted balance thanks to enforceability - there's no way to censor **just you, its security is binary** - either the hub **stops serving all channels** and exit scams (losing on all offchain fees for years to come) or the money will be returned to you no matter what. Still, it's recommended to keep most of the money in onchain or insured balance.

**Usability: High** 

You can receive any amount of money from the hub by setting as high credit limit as possible. But it's strongly recommended to keep a sane credit limit $1-100k and have proper risk management. 

Can be sent/received instantly through the hub. Requires a signature generated on your device (must be online to send)

## Trusted Balance

**Security: Lowest Possible**

That's how all banks, financial hubs and payment providers worked until now. Just a number in some centralized database that can be wiped down any second with no digital proof provided to the customer, no obligations, no control. **The funds are entirely in custody of the central authority.**

**Usability: Highest Possible**

On the positive side, it's a lot easier to use with things like offline payments, subscriptions, physical credit cards - unlike first 3 these payments do not require a signature provided by you - **money doesn't have to be "pushed" and can be "pulled" from your account.**

Our hubs **may** support trusted balance at some point just to be compatible with massive credit cards infrastructure. If that ever happens, those balances will store only small balances <$100 and will be refilled manually when needed.

# 8 Types of Asset Transfers

By a money transfer we mean any method to increase total asset value of the receiver by reducing our own asset value. In total there are 4 scenarios of onchain payments and 4 offchain, **each best suitable for different size of payments**

## Onchain transfers

A user that owns anything onchain can always choose to perform a direct settlement broadcasting a public transaction. **This helps to avoid using a hub, has highest security and no capacity limits.** However, induces higher fee.

In fact there are 4 combinations of such settlement. Standalone outputs have null in place of hubId. 

**Standalone => Standalone** - traditional way to transfer money in all other blockchains. This way you transfer from onchain balance directly to someone's onchain balance. But since onchain balances are harder to spend, it's usually recommended to transfer to a channel.

**Standalone => Channel** - transfering straight into a channel of user@hub (depositing from user's side of the channel). This way the user doesn't have to manually load up their channel again and the funds are ready to use (be sent offchain).

**Channel => Standalone** - withdraw from my channel with hub and send to someone's standalone. Rare usage expected, likely with someone who just prefers standalone balance.

**Channel => Channel**  - **most preferred way to use onchain settlements** is to withdraw money from your channel and deposit to recepient's channel right away, in a single optimized transaction.

## Offchain transfers

Offchain sends may be unconditional (without hashlock, cheaper to service) or with hashlocks. They also can be one-off or streamed (sent in smaller chunks, like subscription. Each second, daily, weekly etc.)

**Offchain unlocked** - most basic type of send. Has no hashlocks - change of delta is unconditional so the hub may simply steal the funds. Perfect for micropayments below $100

**Offchain hashlocked** - adds a hashlock object to signed dispute, this way there's zero counterparty risk but it also induces higher size of dispute and costs to service the lock. Thus is only used for payments $100-10k

**Offchain unlocked streamed** - sending unlocked payments for one invoice in streaming fashion. Streaming is a great way to send large payments even **if there's no capacity by instantly redistributing the funds you receive like salary (cash inflows) to your vendors like rent (cash outflows)**

This way even if the capacity is limited at $1000 you can route $10,000 by sending 10 payments every second and the user fulfils their lazy payments and reroutes your $1000 forward to their own recipients. Requires the recipient to have a lot of lazy (pending) payments. 

**Offchain hashlocked streamed** - same as above but all chunks are hashlocked. Any number of payments can be routed this way as long as there's enough capacity.


