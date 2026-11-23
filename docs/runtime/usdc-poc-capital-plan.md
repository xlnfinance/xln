# USDC PoC capital and gas decision packet

Prepared 2026-11-17 for ticket 10; revised for five sequential runs at the owner's
request. **Unsigned, unapproved and not executable.** Selecting the five-run plan
authorizes preparation of these amounts, not public signing or spending.
The [retained packet](../evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-capital-planjson)
contains the identities, identified chain observations, restored Account proofs,
source/configuration hashes, unsigned calls and estimation limits. It describes a
dirty working candidate based on `b2dceb3438ff2582cee0c5741fe4a0528f5cbd26`, not a
clean release SHA. Public financial broadcasts and new funding authorizations: zero.

This packet's source hashes and public observations predate the ticket-08
[financial CLI](usdc-poc-execution.md). They remain a historical planning
snapshot, not verification of the new executable candidate. Refresh the packet's
candidate, chain points, exact funding calls and funding estimates before requesting
ticket-11 approval. A funded executable maker quote is checked by 05 after 11;
it is not a prerequisite for approving its own funding. The five-run capital
proposal has not itself been approved for funding.

Ticket-11 update, 2026-11-17: the separate
[bounded funding executor](usdc-poc-operator-funding.md) has executed the
[six authorized public transactions](../evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-publicjson):
1/5-USDC Hub capital and exact Hub ETH topups, inside the numeric ceilings below.
The prior inventory/economic projections remain historical planning inputs.
At that point, authenticated observation for the first stand was pending.
[Ticket 12](../../.scratch/ts-usdc-cross-j-poc/issues/12-public-rpc-capacity-and-funded-catchup.md)
records that stopped attempt and the funded restore accepted for the demo.

## Proposed funding scope

Keep the existing operator credit and maker sizing policy unchanged. Budget for
**five sequential Ethereum -> Arbitrum journeys**, each depositing exactly
1,000,000 source units. Propose **6 USDC of operator capital**: the existing
provisional 1-USDC source Hub buffer and **5 USDC in the target Hub reserve**.
Keep the user's **5-USDC series budget separate**, for ticket 06: five individual
1-USDC wallet funding transfers and deposits, not one 5-USDC deposit. No WETH or
second swap token is required. Native ETH pays chain fees.

The 1-USDC source Hub reserve is an operational buffer: the current public
bootstrap requires a positive reserve. The forward user's source collateral is
funded by the user's own 1 USDC; it does not consume this reserve in the normal
ingress path. One atomic unit satisfies the positive-reserve predicate. Retaining
the earlier proposed whole-USDC buffer avoids silently choosing a new amount;
its size is discretionary and has not been justified as a protocol minimum or
measured requirement. It is not multiplied by the number of forward runs.

The 5-USDC target allocation covers five projected net withdrawals below and
leaves 0.500995 USDC. Source deposits do not automatically replenish the Arbitrum
reserve. This allocation is **not backing for the entire maker ladder or operator credit
limits**. This packet does not claim general public liquidity or product solvency.
Do not silently change credit, offers or tariffs to make funding look sufficient.
A different operator policy requires a separate owner decision and new evidence.

## Current inventory

Retained initial verified points: Ethereum Sepolia block **12154601** and Arbitrum Sepolia
block **330105479**. Later independent position checks in the packet confirm
unchanged funds and four empty on-chain user/Hub and MM/Hub collateral positions.
The revised funding packet additionally checks current funder balances, pending
nonces and Hub reserves at its own identified points; the initial inventory and
offline Account proofs are retained observations, not rerun checks. Every point
includes its block hash. Both USDC stacks passed the existing sealed
deployment, current artifact, bytecode and binding checks.

| Holder                                       |          Ethereum Sepolia |         Arbitrum Sepolia |
| -------------------------------------------- | ------------------------: | -----------------------: |
| Funder USDC wallet                           |                    9 USDC |                  20 USDC |
| Funder ETH wallet                            | 41.202999650295764930 ETH | 0.528569400505305600 ETH |
| User, Hub and MM USDC wallets                |                    0 each |                   0 each |
| User, Hub and MM Depository reserves / debts |                    0 each |                   0 each |
| User/Hub and MM/Hub on-chain collateral      |                    0 each |                   0 each |
| Prepared user, Hub and MM ETH wallets        |                    0 each |                   0 each |
| Funder confirmed / pending EOA nonce         |                 106 / 106 |                  30 / 30 |

Funder: `0x42Da3Ba8c586F6fe9eF6ed1d09423eB73E4fe25b`.
Its existing lazy Entity is
`0xaaa77fe2366ac1c1bc54cdcee97e0e95afb7bd999720ea9858257c75fad9d88b`.
Its Depository nonce is 2 on both chains; the proposed deposit uses nonce 3.
These are observations, not reserved nonces. Revalidate before signing.

## Credit, maker depth and one-USDC economics

Canonical offline restore verified the existing public MM WAL at Runtime height 18. Both MM/Hub Accounts are at height 3 and contain **2,000,000 USDC of credit in
each direction**, with zero committed offers. This is permission to owe money;
no USDC is deposited by granting it. The user WAL at height 12 retains two signed
user/Hub Accounts at height 2, with zero credit and the USDC tariffs below.

The unchanged stable-maker policy starts at 10,200 base USDC per offer. Ten price
levels are considered; the Account cross-J cap of 18 Pulls permits nine offers
per directed route with two jurisdictions. Canonical price, lot and orderbook
helpers give this **policy projection**, before live topology and admission:

| Maker direction      | Offers |   Total maker gives |   Total maker wants |
| -------------------- | -----: | ------------------: | ------------------: |
| Ethereum -> Arbitrum |      9 |        208,250 USDC | 208,399.770000 USDC |
| Arbitrum -> Ethereum |      9 | 208,100.230000 USDC |        208,250 USDC |

These are gross route amounts, not a required token deposit or a net credit-risk
calculation. Opposing routes must not simply be added and called net exposure.
The public committed executable depth remains **zero**. The complete production
planner produced no offline route because authenticated live Runtime routes were
absent; the calculation does not fabricate those capabilities. The owning local
USDC-only regression separately proved nine committed offers per direction.

The maker's 10-token minimum quote notional is an offer-size floor, not a minimum
user trade. A 1-USDC order can partially consume a larger offer when exact lots
permit it. For the selected Ethereum -> Arbitrum journey, the user consumes the
reverse maker route. Its first projected price is 9,999 ticks:

| Item                                               | Atomic units (6 decimals) |     USDC |
| -------------------------------------------------- | ------------------------: | -------: |
| User source principal / full execution             |                 1,000,000 | 1.000000 |
| Projected gross target claim                       |                   999,900 | 0.999900 |
| Signed cover fee                                   |                   100,099 | 0.100099 |
| Net target collateral / external payout            |                   899,801 | 0.899801 |
| Source-to-payout difference                        |                   100,199 | 0.100199 |
| Target Hub reserve remaining after the first cover |                 4,100,199 | 4.100199 |

Both signed USDC tariffs have policy version 1, base fee 100,000, liquidity fee
1 bps and gas fee zero. The existing `rebalanceFeeFor` computes the prepaid fee;
the canonical handler requests collateral equal to gross minus that fee. The
target Hub therefore needs 899,801 reserve units for this projection. The source
tariff is recorded, but direct user-funded source R2C does not charge a second
Hub cover fee in this journey. Existing Account Hankos and roots bind the tariffs;
05 must re-read the effective terms and actual quote before fixing exact user
target credit or claiming executable economics. The projection satisfies the
850,000 payout floor and 150,000 total token-difference ceiling.

## Five-run budget and repetition

The following projection assumes the same quote and effective tariff in every
run, no unrelated reserve use, and completed cover/exit before advancing:

| Completed runs | Cumulative source deposits | Cumulative external payout | Remaining target Hub reserve |
| -------------- | -------------------------: | -------------------------: | ---------------------------: |
| 1              |              1.000000 USDC |              0.899801 USDC |                4.100199 USDC |
| 2              |              2.000000 USDC |              1.799602 USDC |                3.200398 USDC |
| 3              |              3.000000 USDC |              2.699403 USDC |                2.300597 USDC |
| 4              |              4.000000 USDC |              3.599204 USDC |                1.400796 USDC |
| 5              |              5.000000 USDC |              4.499005 USDC |                0.500995 USDC |

Across five successful runs, projected cover fees total 0.500495 USDC and the
source-to-payout difference totals 0.500995 USDC. Each run independently must
execute its whole 1 USDC, pay at least 0.85 USDC externally, and lose no more than
0.15 USDC. Aggregate totals cannot compensate for a failed or partial run.

Keep unspent user principal in the funding wallet and transfer exactly 1 USDC
to the source user wallet for the next run. The observed 9 source USDC cover the
1-USDC operator buffer plus five 1-USDC user transfers, leaving 3 USDC unallocated.
The observed 20 target USDC cover the 5-USDC operator deposit, leaving 15 USDC
unallocated. Those unallocated balances are not spending authority or an assigned
recovery budget. Fund the Hub reserves once; never repeat prefunding per run.

Ticket 08 now supports unique run/order identifiers and reuses the same existing
vaults, Entities, Accounts and stores, with five-run private-chain evidence.
Recover the same run ID after interruption; do not start
a replacement run or repeat its financial effects while its receipt, Pulls or
Account ACKs remain unresolved. Compare deposits and address-B payouts by each
run's balance deltas, since successful earlier runs change absolute balances.

Ticket 05 must refresh the actual quote, effective tariff, exact target credit,
free reserve/backing and native budget before each run. Reject a run whose exact
cover cannot be funded from free reserve after existing obligations. Do not
reset funded stores or treat a cancellation as a successful run. This budget
does not guarantee five successes after arbitrary failures or price/fee changes.

## Unsigned ticket-11 operations

Each row is paid by the funder. USDC is the selected chain's listed token 1.
The packet contains exact addresses, ERC20 calldata, encoded JBatch and the
chain/depository/nonce-bound Hanko digest. It contains no new Hanko or Ethereum
transaction signature. Full `processBatch` calldata cannot be completed without
the funding Entity's authorized Hanko.

| Chain    | Ordered operations                              | Destination                                   |
| -------- | ----------------------------------------------- | --------------------------------------------- |
| 11155111 | approve 1 USDC; E2R 1 USDC; transfer 0.001 ETH  | Source Hub reserve; source Hub signer for ETH |
| 421614   | approve 5 USDC; E2R 5 USDC; transfer 0.0001 ETH | Target Hub reserve; target Hub signer for ETH |

The spender is the chain's verified Depository. Deposit recipient is explicitly
the Hub Entity, while the funding lazy Entity authorizes the batch and the funder
EOA supplies ERC20 allowance and gas. Hub Entity nonce is not the funding nonce.
Approve exactly the proposed deposit: 1,000,000 source units and 5,000,000 target
units, rather than an unlimited amount. Re-read both allowances and nonce domains
before signing; the packet records their observations, not reserved nonces.
No MM USDC wallet deposit or MM reserve deposit is proposed: current maker
admission uses bilateral credit. The resulting maker claims remain unsecured
beyond the deliberately funded series of user exits described above.

User principal funding, user approval, source E2R/R2C, Cross-J and payout are
excluded from 11. The packet retains a separate unsigned 1-USDC source-wallet
transfer template and its retained estimate for later journey preparation. The
five-run budget repeats this one-USDC template with separately resolved nonces;
it does not change the template's amount to five USDC. Neither that transfer
nor its estimate grants authority to execute it. MM/User ETH needs remain for 05.

## Funding gas: measurements and proposed limits

The revised packet contains fresh estimates at its own identified points for
the exact 1-USDC source approval, 5-USDC target approval and Hub ETH transfers.
These points are Ethereum Sepolia **12154725** and Arbitrum Sepolia **330110908**;
the packet retains both block hashes. The numeric table below is updated from
that packet. These are
RPC estimates, not receipts or minimum consensus gas. Native transfer estimation
on the selected Ethereum RPC returned 207,391; do not replace it with an assumed
21,000. Gas-price samples are taken near these points; `eth_gasPrice` itself has
no block selector.

| Chain / call            | RPC estimate | Proposed gas limit | Evidence quality                            |
| ----------------------- | -----------: | -----------------: | ------------------------------------------- |
| Ethereum approve        |      140,018 |            200,000 | Exact unsigned call, current allowance      |
| Ethereum Hub E2R        |   Unmeasured |            600,000 | Conditional cap; prior deposit used 456,626 |
| Ethereum ETH transfer   |      207,391 |            300,000 | Exact unsigned call                         |
| Arbitrum approve 5 USDC |       56,240 |             90,000 | Exact unsigned call + Nitro components      |
| Arbitrum Hub E2R        |   Unmeasured |            600,000 | Conditional cap; prior deposit used 188,422 |
| Arbitrum ETH transfer   |       21,000 |            300,000 | Exact unsigned call + Nitro components      |

Prior deposits are successful canonical public receipts against the same stacks,
but credited the funder's reserve. A new Hub recipient, authorization, nonce and
allowance state can change gas. Their receipt costs are historical references,
not measurements of the new batch or its revised 5-USDC amount. No fake Hanko or RPC state override was used
to hide this missing estimate. After explicit funding authority, sign the exact
approved digest and estimate the complete call after confirmed approval, before
broadcast. Reject if it exceeds the approved cap; refresh the packet instead of
silently increasing it.

| Funder limit                                       | Ethereum Sepolia | Arbitrum Sepolia |
| -------------------------------------------------- | ---------------: | ---------------: |
| Proposed max fee per gas                           |           1 gwei |         0.1 gwei |
| Proposed max priority fee per gas                  |         0.1 gwei |                0 |
| Three normal calls at their gas/fee caps           |     0.001100 ETH |     0.000099 ETH |
| Cumulative funding fee ceiling, including recovery |     0.002000 ETH |     0.000200 ETH |
| Unspent portion reserved for recovery              |     0.000900 ETH |     0.000101 ETH |
| ETH value sent to Hub signer                       |     0.001000 ETH |     0.000100 ETH |
| Maximum funder native outflow                      | **0.003000 ETH** | **0.000300 ETH** |

These are conservative **proposed authorization ceilings**, not expected costs
or authority. The old 0.2/0.1-ETH provisional journey envelopes are not reused as
measured funding requirements. ETH sent to a Hub stays its wallet balance and
is not also a paid gas fee. Receiving ETH does not authorize Hub broadcasts in 11.
All other payer/chain spending authority in 11 is zero. Later Hub spend from that
balance needs the separate journey budget; User/MM budgets are not yet assigned.
The number of funding calls is unchanged, so these proposed funding-only
ceilings are not multiplied by five. They do not certify gas sufficiency for
five journeys. Ticket 05 must calculate normal and recovery gas per payer for
the series, including any additional Hub/User/MM topups; current Hub topups are
only initial allocations. Insufficient funds reject before the affected run.

Arbitrum estimates already include the L1 posting component; do not add it twice.
The packet records NodeInterface components for the revised approval and ETH
transfer at the new observation. These are point-specific component observations,
not an assumption that future posting costs are zero. See the official
[Arbitrum estimation guide](https://developer.arbitrum.io/arbitrum-essentials/how-to-estimate-gas)
and [EIP-1559 fee fields](https://eips.ethereum.org/EIPS/eip-1559).

The implemented funding executor retains one payer/chain cumulative ceiling
across restarts, with exactly three nonce slots. Fixed signing inputs reconstruct
the same transactions; it does not automatically bump fees. A consumed same-nonce
replacement must satisfy the exact original call and fee bounds. A mined revert,
unknown pending transaction or insufficient remaining budget stops execution.
New-nonce retries, cancellation and forced recovery require a separately reviewed
remaining-obligation packet; the unspent ceiling alone does not authorize them.
The preparation provider rejects submission; the separate funding executor
enforces these limits at execution. See its guide for the current authority.

## Remaining prerequisites and verification

Ticket 10 prepares a decision; it does not approve funding or finish 05. The
following still belong to their existing owners:

- **08 is complete locally:** the [financial CLI](usdc-poc-execution.md) implements
  public configuration, repeatable run IDs, same-WAL recovery and finite normal-flow
  payer/nonce limits. Its grant does not authorize the funder, operator prefunding,
  native ETH transfers or forced dispute/recovery transactions.
- **11:** public funding and receipt accounting are complete under explicit
  authority. Canonical J observation and same-store funded restore wait for 12.
  Keep the consumed campaign separate from normal-flow/user authority; no user
  deposit was performed in this step.
- **05:** funded live maker depth, selected exact quote and user credit, effective
  tariffs, target backing and complete five-run costs for source approval/E2R/R2C, target
  Hub cover R2C, user C2R/R2E, any registry calls actually emitted, and required
  Hub/MM/User clear/dispute/finalize/recovery operations. Identify actual payers,
  not only transaction kinds; reserve native balances before their broadcasts.
- **06:** separate full-journey authority and the public 1-USDC-to-address-B proof.
  A conditional quote, funded reserve or safe partial cancellation is not that proof.

The original ticket-10 revision changed documentation/evidence only. Its retained two canonical offline restores
verified the persisted frame roots and existing Account Hankos without starting
the Runtime loop, watchers or P2P. The prior final read checked six identities, four
collateral positions and both funder balances/nonces without changes. Production
source/configuration hashes match the candidate recorded before the observations;
the existing green runtime checks are reused for that unchanged executable. The
five-run revision checks packet encoding/digests, exact approval amounts, reserve
arithmetic and unchanged source hashes; it does not claim five executions.
