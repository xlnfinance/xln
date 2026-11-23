# 14: Verify two sequential public 1-USDC runs on one fresh stand

Type: implementation
Category: enhancement
Completed: yes
Status: ready-for-agent
Blocked by: None

On 2026-11-23 the owner narrowed acceptance to the first two sequential
1-USDC journeys on `ticket14-fresh-C5kNYZ`. The stand used the existing
Ethereum Sepolia and Arbitrum Sepolia deployments and its own Hub, MM and
user vaults and WALs. The original five-run manifest and the outcome of run 3
remain part of the campaign record below.

## Acceptance criteria

- [x] Prepare the fresh Hub, MM and user WALs, then reconcile the new Hub
      reserves after authorized funding and authenticated observation. Record
      the once-only operator funding and the two separate 1-USDC principal
      transfers and deposits.
- [x] Before each run, require both operators ready, an executable quote for
      the full 1 USDC, effective signed tariff, exact target credit, available
      reserve net of obligations, user principal, and payer nonces and ETH.
      Verify the first external payout before admitting the second run.
- [x] Record the native gas caps and receipt-derived spending for six source
      user slots, two target Hub slots and two target user slots, including the
      observed Arbitrum L1 posting component. Require exact gas estimation
      after each prerequisite and before broadcast.
- [x] Preserve the original WAL and authorized nonce and fee bounds for the
      two accepted runs. Record any additional recovery calls separately and
      require separate authority for them.
- [x] Verify eligible and blocked outcomes. Produce an unsigned plan bound to
      the candidate, catalog, identities, anchors, run IDs and limits. Obtain
      separate owner approval before any public financial execution.
- [x] Prove two completed public journeys on the same stand. Reconcile all
      10 journey receipts, per-run and cumulative external payouts, payer fees,
      exact nonce windows and the final Hub reserve. Retain signed Cross-J and
      verified WAL evidence with zero source remainder, open Pulls or pending
      Account ACKs for each completed run.

## Two-run acceptance

Both runs deposited exactly 1 USDC on Ethereum Sepolia and made one full
Cross-J fill followed by an external withdrawal to the same Arbitrum Sepolia
user wallet. Two RPCs reconciled all ten receipts. The signed traces verified
both Account commitments, the maker fill, the Pull reveals and zero transfer
remainder, open Pulls and pending Account ACKs. `bun run check` passed on the
clean execution candidate `f95c5e1b2` before the campaign.

| Run   | Journey receipts | External payout | Target Hub reserve after withdrawal |
| ----- | ---------------: | --------------: | ----------------------------------: |
| Run 1 |                5 |   0.899801 USDC |                       4.100199 USDC |
| Run 2 |                5 |   0.899801 USDC |                       3.200398 USDC |

| Chain and step              | Run 1 transaction hash                                               | Run 2 transaction hash                                               |
| --------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Ethereum Sepolia approve    | `0x4bb96c693e5d8aef8cd84871307f8934d8a251514ff882f53a62062df11c39bf` | `0x6686b88c384ba39ca63c3e5a18cf15b27ef7d3c35002397712f5f3d6c8678c57` |
| Ethereum Sepolia deposit    | `0x201242e45e61eab7092ef5bc6051db85178b8cfcb4e312a6d579aea3696c79d9` | `0xb6905a09edd30f66d013a06230f98e577739096dd8acc2ad9fe69ef4606ca341` |
| Ethereum Sepolia collateral | `0xc93cb8159e78b26b93af2aac4a9b209dfa44a1a370a71bf0b950dd5027d6fba4` | `0xe5d77c0412a834a61abe9af0beed59f3d0c95387667084bc1d1fccfba9b53947` |
| Arbitrum Sepolia cover      | `0xe4abd10e3401fa38e190b6522ea9a8ebd27d98dc6ba42ca2614c6415d0dd2e9e` | `0x20f0fc9669f1232225e578ba88ab1b595228ed6a0007544edf701e4aac6c3a75` |
| Arbitrum Sepolia withdrawal | `0x71cffdc4158ae624a00ace27ce4f12a2966d062f9818d9cbcad26cd46299ee0d` | `0x792a55dbe90cd3bf34200e3364280f2ed90ea37b5dc65b9b7f7808a40d40023e` |

The accepted pair deposited **2 USDC** and paid **1.799602 USDC** externally.
Funding for the pair comprised six operator calls, two user ETH topups and
two separate 1-USDC principal transfers at Ethereum funder nonces 138 and 139.
All ten funding calls were confirmed.
The second transfer followed verification of the first withdrawal.

| Journey payer         | Used nonce slots | Two-run fee cap |   Actual fee (wei) |
| --------------------- | ---------------- | --------------: | -----------------: |
| Ethereum Sepolia user | 0–5              |    0.003600 ETH |         19,176,513 |
| Arbitrum Sepolia Hub  | 0–1              |    0.000100 ETH |  6,775,782,336,000 |
| Arbitrum Sepolia user | 0–1              |    0.000140 ETH | 10,222,401,200,000 |

The fee caps cover the first ten slots of the original manifest. The four
Arbitrum receipts report zero `gasUsedForL1` for these calls. The
[local archive](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#ticket-14-campaign)
retains the signed traces, WAL checks, quotes, tariffs, backing reads and fee
accounting. The accepted pair used zero additional on-chain recovery calls.
Its recovery boundary is the original WAL, accepted
transaction hash and authorized slot. A replacement, new nonce, C2R or dispute
requires separate authority.

## Original five-run campaign record

The original approved journey grant reserved 0.009 ETH for the source user,
0.00025 ETH for the target Hub and 0.00035 ETH for the target user.

- [Five-run capital and gas decision](../../../docs/runtime/usdc-poc-capital-plan.md)
- [Single-run payer caps and gas observations](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-preflight.json)
- [Recovery matrix](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#interrupted-recoveryjson)
- [Retained fresh-demo recovery and reuse evidence](05-public-preflight-and-gas-plan.md#recovery-evidence-for-follow-up)

### Fresh campaign preparation

`ticket14-fresh-C5kNYZ` used clean candidate `f95c5e1b2` and the existing
Ethereum Sepolia and Arbitrum Sepolia deployments. The new user opened both
signed Accounts. The stopped WALs passed integrity verification for all 101
frames. New Hub funding is 1 USDC on Ethereum Sepolia and 5 USDC on Arbitrum
Sepolia. The plan scheduled five separate 1-USDC wallet transfers to provision
the user's source principal one run at a time. Four later transfers depended
on the verified external payout of the prior run. Reserve funding, user wallet
funding and the 25-slot user journey each had separate authority boundaries.

The original campaign budget was 6 USDC on Ethereum Sepolia and 5 on
Arbitrum Sepolia.
After the owner topped up the funder, two RPCs confirmed 22.999995 USDC on
Ethereum Sepolia and 10 USDC on Arbitrum Sepolia. Both native balances cover
the draft caps. The refreshed packets bind the same stand and candidate,
funder nonce slots 134–142 and 53–56, and a 20:30 UTC deadline on 2026-11-22.
The owner later approved both exact packets.

The five-run Anvil scenario passed on the same clean SHA with 70 assertions
in 123.95 seconds.
It completed five journeys on one user WAL, recovered an interrupted deposit
and withdrawal, and reconciled the original execution without a duplicate
debit. Negative cases covered missing and expired authority, a changed
candidate, missing gas or principal, an out-of-scope run ID and a history write.

The approved operator funding manifest SHA-256 is
`4391585e7dce2ec0a9153062e659e63ff9f7c4b1cf5e5e5be1a5e0a1f26120d9`.
The approved user wallet funding manifest SHA-256 is
`b634aae9f592b573fb5ca362e2a197af96890d30be24c7348eefdd94ffb07a05`.

### Initial funding confirmed

The owner approved the two exact funding packets until 20:30 UTC on
2026-11-22. Nine calls succeeded and were independently reconciled with two
RPCs. The six operator calls established the 1 and 5 USDC reserves and the
approved signer ETH balances. Both user native topups and the first 1 USDC
source wallet transfer also succeeded. Funder confirmed nonces advanced to
139 on Ethereum Sepolia and 57 on Arbitrum Sepolia. The four remaining
Ethereum principal slots, 139–142, were bound to the verified payouts of their
predecessor runs. The owner authorized the 25 journey slots separately.

At 17:47:41 UTC the funded restore verified both Hub reserve observations
and a real executable MM quote for the entire 1 USDC. Tariff version 1
gave 0.999900 USDC gross, a 0.100099 USDC fee and a projected net payout of
0.899801 USDC. At that price the confirmed target reserve covered all five
planned runs. The live preflight refreshed the price, signed tariff and backing
for each admitted run. The gas reservation covered all 25 nonce slots. Independent
verification covered all 123 WAL frames. The exact first approval estimate
is 140,018 gas against a 600,000 cap. All three journey payers are at `0/0`.

The unsigned five-run manifest specified a deadline of 20:25 UTC on 2026-11-22. Its
SHA-256 is `e291f5ce229e222ee7e177b011c6ae4e7131ef6149654e4b0b67665ec8e7be99`.
The read-only session completed with zero signatures and zero broadcasts.

### Public campaign stopped during run 3

The owner approved the five sequential runs under the exact journey manifest.
Execution on `f95c5e1b2` stopped at 20:10:52 UTC on 2026-11-22 during run 3.
Runs 4 and 5 were unstarted.

Two independent RPCs verified 13 of 25 journey receipts and 11 of 13
funding receipts, with zero mined reverts. The stopped WALs passed integrity
verification over 547 frames (147 user, 274 Hub and 126 MM).

Run 1 used the managed CLI. Runs 2 and 3 used the documented persistent Hub/MM
session with a separately restored user Runtime for each run. This avoided
repeating the MM history catch-up at every run. During run 2 the MacBook slept
for 4m45s when its lid closed. The same session resumed, and the Hub recovered
its Ethereum read window from one to 31 blocks before completing the run.

Run 3 consumed Ethereum user nonce 6 for approve, nonce 7 for E2R and nonce 8
for R2C. R2C transaction
`0x77152ce6a95e6d72e76c26fd86455f48a4866db56f2f93632f8d36856ccb2594`
added exactly 1 USDC to on-chain collateral at block 12190953.
Both Runtimes authenticated that event. The Hub rejected two Account frame
deliveries with `ACCOUNT_INPUT_FRAME_STRUCTURE_INVALID`. The frame was ahead
of the receiving Entity's timestamp by 214.539 s and 189.612 s against a 30 s
limit. The bilateral update remains unfinished. The stopped user WAL at
height 147 has no route for run 3 and shows zero available source collateral
for that run. The source 1 USDC is present in the Depository collateral. Run 3
produced no Cross-J or Arbitrum transaction.

The original WALs remain intact. The final `latest/pending` pairs were 9/9 for
the source user, 2/2 for each target payer, and 141/141 and 57/57 for the funder
on Ethereum and Arbitrum respectively. The unused journey slots are source
9–14 and target 2–4 for each payer. Funding slots 141 and 142 remain unused.
Confirmed journey gas totalled 28,854,168 wei for the Ethereum user,
6,775,782,336,000 wei for the Arbitrum Hub and 10,222,401,200,000 wei for the
Arbitrum user. There were zero replacement, C2R or dispute transactions.

The next diagnostic is to capture the sender Account frame timestamp and
receiver Runtime and Entity candidate timestamps at the first disagreement.
The existing logs establish the skew at Account admission. They do not pin
the exact clock input responsible for each frame. Any financial continuation
needs a new exact grant covering only the remaining effects.
