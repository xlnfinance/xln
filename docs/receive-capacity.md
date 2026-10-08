# receive capacity spectrum

Date: 2026-09-05. Researched SHA `b97c454d605e750a08da7ff6baab645330175468`.
Status: Receive and Pay→Move verified with a real browser; the lease protocol is not yet implemented.
Scope: React `/ui`, receiving in a bilateral Account, receive/swap/cross-j/lending.
Latest owner decision: Spectrum only on the inbound side. On Pay — a transition into a pre-filled Move.
Normative constraints remain in [fints.md](fints.md) and [consensus-invariants.md](consensus-invariants.md).

## the decision on one screen

One control answers the question: **"What should prepare the missing capacity for receiving?"**
On the left — 100% hub collateral, on the right — 0% collateral and a permanent user credit to the hub.
The setting applies to the missing part of a specific operation, not to the whole balance.
Below is the target mockup; the availability of the collateral action is limited by the current protocol, see further below.

```text
Prepare to receive                     1 000 USDT · Ethereum
Available 600 · Need 400 more                          Via H2

100% collateral                                   0% collateral
●────────────────────────────────────────────────────────
Collateral 400 USDT · Additional unsecured 0 USDT

Fee: … USDT · Ready: after confirmation
[ Request collateral ]
```

Reason: a single choice replaces scattered manual navigation in Manage and hidden credit setup.
Condition for usefulness: the Runtime can actually execute the chosen method before the operation.

## what has already been found in the code

| Observation                                         | Evidence                                                                                                             | Consequence                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| The current wallet is React `/ui`                   | [App.tsx:72](../ui/src/App.tsx#L72), [vite.config.ts:48](../ui/vite.config.ts#L48)                                   | Integrate into React; do not design a new Svelte wrapper |
| The wallet is built from the committed view frame   | [views.ts:15](../ui/src/runtime/views.ts#L15), [views.ts:157](../ui/src/runtime/views.ts#L157)                       | Take capacity and states from one confirmed snapshot     |
| Receive sums the inbound of several Accounts        | [Receive.tsx:53](../ui/src/screens/Receive.tsx#L53)                                                                  | This sum does not prove the capacity of a single route   |
| Pay selects one route/first hop                     | [Pay.tsx:117](../ui/src/screens/Pay.tsx#L117), [payments.ts:35](../ui/src/runtime/financial/payments.ts#L35)         | Check source outbound and target inbound separately      |
| Receive offers credit only at zero capacity         | [Receive.tsx:106](../ui/src/screens/Receive.tsx#L106)                                                                | A partial shortfall does not yet get a solution          |
| Cross-j shows automatic account/credit steps        | [Swap.tsx:159](../ui/src/screens/Swap.tsx#L159), [Swap.tsx:409](../ui/src/screens/Swap.tsx#L409)                     | Replace implicit credit with an explicit shared choice   |
| Manage passes the exact fee policy                  | [manage.ts:20](../ui/src/runtime/financial/manage.ts#L20), [manage.ts:30](../ui/src/runtime/financial/manage.ts#L30) | Use the published committed policy and its version       |
| "Request credit" asks the hub for credit            | [manage.ts:170](../ui/src/runtime/financial/manage.ts#L170)                                                          | The needed direction for SEND, not for RECEIVE           |
| "Extend credit" allows the hub debt toward the user | [AccountDetail.tsx:469](../ui/src/screens/AccountDetail.tsx#L469)                                                    | This is the needed direction for the credit part         |
| The global receipt appears after completion         | [receipts.ts:99](../ui/src/runtime/financial/receipts.ts#L99)                                                        | The receipt cannot be used as prior consent              |

The old [CollateralForm.svelte:36](../frontend/src/lib/components/Entity/account/ui/CollateralForm.svelte#L36) shows minutes and `$1 per $100 per hour`.
[Payload:219](../frontend/src/lib/components/Entity/account/ui/CollateralForm.svelte#L219) does not contain a term: only `amount`, `feeTokenId`, `feeAmount`, `policyVersion`.
**This is not proof of an existing time-based lease.** Do not carry the estimate/timer over into the new feature.

A check of core clarifies the boundary of existing functionality:

- The payload fixes gross/fee; `requestedRebalance` stores the net after fee in the same token.
  The hub scheduler limits execution to the existing unsecured debt; at zero it does not fund a future receipt.
  [rebalance.ts:244](../core/entity/scheduler/rebalance.ts#L244).
- Free excess collateral goes into the automatic C→R plan; preserving leased capacity is not implemented.
  [rebalance.ts:437](../core/entity/scheduler/rebalance.ts#L437).
- `set_credit_limit` sets an absolute permanent limit; it does not add an amount and does not restrict
  the permission to a single operation. [set-credit-limit.ts:40](../core/account/tx/handlers/balance/set-credit-limit.ts#L40).
- Borrow gives credit for sending, not a transfer of principal to the recipient's Account.
  The real transfers are `lending_fund`, `lending_repay`, `lending_close_payout`.
  [lending.ts:76](../core/account/tx/handlers/balance/lending.ts#L76), [lending.ts:151](../core/account/tx/handlers/balance/lending.ts#L151).

**Leasing future inbound capacity requires protocol work.** A user's own R→C for SEND already has a path.
Until the lease is implemented, the RECEIVE preview shows it as unavailable and does not send an unsuitable rebalance.

## the inbound choice and simple top-up before a payment

RECEIVE: "Lease collateral" / "Lease collateral and increase the limit" / "Increase the limit to the hub".
The lease requires a quote accepted by the hub and an executable obligation; the user signs their own grant.
The grant does not transfer money: debt arises upon use. Show the risk of the hub's debt.
While the lease is absent, the collateral option is explainably unavailable, not replaced by credit.

SEND: **no Spectrum or new credit request**. The "Top up for payment" button
opens the existing [Move](../ui/src/screens/Move.tsx) with the account, J, token, and the calculated
amount. The source is the user's own reserve; if it is insufficient, an on-chain wallet can be chosen.
Move uses the existing canonical path and its own signature. After the committed top-up,
the user returns to the saved recipient/amount for a new quote and Pay confirmation.
Topping up does not mean permission to automatically send the payment.

The R→C amount is calculated by the Runtime projection: old debt/credit may absorb part of the deposit.
The missing route fee is explicitly unknown when there is no route; do not present the preliminary
amount as the exact all-in figure. A Move error/cancellation preserves the draft but does not open Pay via a toast.
The return destination is restricted to the local Pay; the parameters do not allow an external redirect.
Changing Entity/Account/J/token requires a new check, not a continuation with the old authorization.

The existing credit API remains a separate Manage path. The identified risks of its `alreadySatisfied`
and of the absolute grant are described in [credit.ts:82](../core/api/server/faucet/credit.ts#L82);
the new Pay does not use this API and does not mask the problem with a frontend workaround.

## the exact meaning of the choice

Identity: Runtime → Entity → jurisdiction → counterparty Account → token; the same symbol in different Js does not merge assets.

- `A` — the admission/hold of the new operation with its fees; existing holds are already accounted for in `C` and are not added again.
- `C` — the `inCapacity` of the chosen Account, with holds/allowances accounted for.
- `D = max(0, A − C)` — the missing part shown to the user.
- The slider distributes `D` between collateral and an additional unsecured allowance.

The formula explains the UX; the calculation remains in the Runtime via `deriveDelta`.
`A` — the full inbound admission/hold with rounding, not a nice expected/min-net number.

Example: 1,000 is expected; 600 is currently available; the shortfall is 400; 75% collateral is chosen.
On screen: "300 collateral + 100 additional unsecured" for a shortfall of 400.
Do not promise "75% of the whole payment is collateralized": the existing 600 may include previously extended credit; show the resulting position.

"300 collateral" is the target result, not the size of the R→C: the deposit may first cover old debt; the fee also changes the Delta.
Instead of `deposit = D × share`, the planner projects the canonical Delta after fee/deposit and recomputes capacity/risk.

**The permanent Account limit is approved by the owner.** The consent shows the old → new absolute limit;
preparing a specific payment does not mean the limit automatically reverts after the payment.
The existing grant and previously accepted risk are not silently reduced.

Owner decision from 2026-09-06: a +10% buffer **on the entire required limit**, on by
default, visible, and disableable. This replaces the previous buffer that applied only to the new increment.
After the canonical projection/split: `required = currentLimit + requiredIncrease`,
`newLimit = required + ceil(required/10)`. For example, 100 → required 150 → new limit 165.
The preview calculation does not change the Account and does not add a new 10% on every refresh.
At 100% collateral or `D=0`, the buffer is zero: it does not create a hidden credit/rental request.
Subsequent owner decision: the arbitrary `FINANCIAL.MAX_CREDIT_LIMIT` is removed.
Credit uses the full uint256 format. The previous ceiling limits neither the needed
increase nor the +10%. Only at the boundary of uint256 itself does the optional buffer shrink
to the representable remainder; the planner returns the requested and the actual buffer separately.
The amount needed for the operation is not reduced. If it already does not fit the numeric format,
the planner returns an explicit error without a command. This is not a product-level amount limit.

The default has already been set by the owner: 100% collateral; a new operation or a change of Account/token/jurisdiction resets it.
Saving the risk preference for the future is a separate explicit action, not a side effect of the drag.

## fee: gross, net, time

The current Manage shows `net = gross − fee`; the fee includes base, gas, and a share of gross.
Sources: [manage.ts:26](../ui/src/runtime/financial/manage.ts#L26), [AccountDetail.tsx:202](../ui/src/screens/AccountDetail.tsx#L202).

The user chooses the useful result, so the planner returns separately:

- how much additional collateral is required;
- the gross of the request, the exact fee, the net of the received collateral, and the payment token;
- the new credit limit, the additional unsecured risk, and the readiness conditions;
- the availability of the method, the evidence fee policy, and the reason for refusal.

It is not permitted to promise a net `D` when gross is `D` and the fee is deducted; the gross calculation is integer and canonical, not a UI formula.
A missing policy or insufficient liquidity make the option unavailable.
`fee ≥ gross` forbids the chosen option when the token is the same; amounts of different tokens
are not compared this way. With a separate fee token, the collateral request remains `amount`.
The current handler also requires a positive fee and sufficient outbound capacity to pay it:
[request-collateral.ts:89](../core/account/tx/handlers/rebalance/request-collateral.ts#L89).
It is not permitted to silently shift the choice to the right in order to replace unavailable collateral with credit.
Owner decision from 2026-09-06: **collateral for a specific request with a timeout**,
with a hub quote. A separate lease for an arbitrary term is not included in v1.
The quote links the request, amount, fee, deadline, J-clock, and the conditions for releasing the collateral.
The duration is set by the chosen J block/timestamp, not by a tab timer; the UI calculation is ETA only.
What is paid for is prepared capacity, not endless top-up; the part occupied by the payment does not become free again.
Expiry does not return the hub's collateral to the user's claim and does not cancel already-signed debt.
The basis of the economic model and the value of the +5% margin, griefing protection, expiry/refund — a separate specification
`docs/liquidity-lease.md`; this document does not invent a rate or an already-active hub obligation.

## where to show it

| Flow                                               | Placement and action                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receive with a known amount                        | Below the amount, before promising invoice readiness; choose the inbound Account                                                                        |
| Receive without an amount                          | Show availability; offer to specify an amount or separately prepare a limit                                                                             |
| Pay                                                | Own shortfall → pre-filled Move; someone else's inbound cannot be fixed with someone else's signature                                                   |
| Same-j swap                                        | Spectrum only for the want-token; the give-token is funded separately via Move                                                                          |
| Cross-j swap                                       | Spectrum only for the target RECEIVE on the user's own Entity/hub/J; the source is topped up via Move                                                   |
| Borrow                                             | The grant increases outbound; this is not receiving principal and not a reason for Spectrum                                                             |
| Lending fund/repay/close payout                    | Spectrum at the real recipient; for the lender — close payout, for the hub — fund/repay                                                                 |
| Move external/reserve→Account                      | Check the allocation; one's own outCollateral does not prove inbound. Do not pay for collateral again if the needed allocation is already being created |
| Manage                                             | The same primitive for the expected amount; manual advanced controls separately                                                                         |
| Open account                                       | The same concepts; do not silently change the existing auto-rebalance policy                                                                            |
| An already completed operation                     | Only the result; a later slider does not change a signed transfer                                                                                       |
| Token transfer to a regular EVM address/to reserve | No Account shortfall: this primitive is not needed                                                                                                      |

Reference operations: [swap.ts:121](../ui/src/runtime/financial/swap.ts#L121), [Lending.tsx:69](../ui/src/screens/Lending.tsx#L69),
[move.ts:209](../ui/src/runtime/financial/move.ts#L209), [Home.tsx:435](../ui/src/screens/Home.tsx#L435).
The direction of collateral sets the allocation: [Depository.sol:774](../jurisdictions/contracts/Depository.sol#L774), [utils.ts:26](../core/account/utils.ts#L26); R→C by itself does not mean readiness to receive.
The cross-j slider does not change `route.riskMode`: this is a different protocol parameter, where currently only
`fully_collateralized` is allowed, although Account admission checks total capacity including credit: [cross-j/index.ts:325](../core/extensions/cross-j/index.ts#L325).

## interaction and states

Drag changes the preview; sending happens only via an explicit CTA.
The CTA shows the inbound choice from the table above; the lease is available only via a real quote.
Below the credit CTA, the permanent limit, the buffer, and who will be able to owe whom are visible.

| State                                     | What the user sees                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `D = 0`                                   | "Ready to receive"; the slider is collapsed or inactive; no extra CTA                      |
| Account not selected                      | Choice of hub/jurisdiction; overall wallet capacity does not replace it                    |
| Calculating                               | The amount and the chosen share are preserved; sending is blocked until the result         |
| Collateral unavailable                    | A specific reason and explicitly selectable alternatives                                   |
| Conditions changed                        | A new calculation; an increase in fee/risk requires a new confirmation                     |
| Sent                                      | "Terms accepted" → "Waiting for hub" if needed → "J sent" → "Confirming" → "Done"          |
| Partial success                           | It is visible which actions are already committed; closing the window does not cancel them |
| Timeout/error                             | The Runtime reason, the saved choice, safe continuation based on the actual state          |
| Recovery/dispute/offline                  | The reason for the block; no optimistic readiness                                          |
| Swap quote went stale while waiting for J | A new quote before the swap; the previous price is not promised                            |

The transition to "Done" depends on the committed Account/J state, not on HTTP 200, submit, or a toast.
A change of route, token, policy, holds, or the arrival of a parallel payment requires a recalculation.
On retry, the UI must continue the already-signed action, not create a second fee payment.
For orders with late/partial execution, it is not permitted to promise eternal capacity based on a one-time preview.
Automation continues the preparation without a manual refresh and returns the original operation to execution.
Show the ETA as a range based on the observed chain; on delay, update the estimate and explain the stage.
Zero on the countdown does not mean readiness: only committed J/Account evidence unlocks the action.

An undeclared receipt is a separate admission question; a terminal receipt is not a prior notification.
When capacity is insufficient, it is not permitted to automatically issue credit on behalf of the recipient,
to hang inside RJEA until a click, or to claim that a rejected transfer is "waiting".
The first path: invoice/quote and a correct retry; a background request requires an explicit intent/admission protocol.

## appearance and accessibility

The current default is matte Obsidian; blur is already used in mobile navigation.
Sources: [design.ts:23](../ui/src/runtime/design.ts#L23), [app.css:122](../ui/src/styles/app.css#L122).

- Track: `--coll`; the credit part of RECEIVE — `--risk`.
- Glass: handle/light glare/thin border; the numbers and fee on a stable, readable backing.
- Native HTML range; moving right increases the unsecured share, the visible collateral% decreases.
- Visible end labels, a label, values in the token; color is never the sole carrier of meaning.
- A 44px touch zone, keyboard arrows/Home/End, presets of 100/50/0, and exact numeric input.

`aria-valuetext`: "75% collateral: 300 USDT; unsecured: 100 USDT"; every pixel of drag is not announced as an alert.
Preserve the light/dark/material presets, focus ring, and `prefers-reduced-motion`.
Sources: [tokens.css:39](../ui/src/styles/tokens.css#L39), [base.css:65](../ui/src/styles/base.css#L65).
An inline card is preferred; [Sheet.tsx:16](../ui/src/components/Sheet.tsx#L16) does not yet implement focus trap/restore/inert siblings.

## implementation boundaries: three owners, one path

The interfaces proposed below are a design, not already-existing APIs.

| Owner                | Accepts                                                          | Returns/does                                                                  |
| -------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Runtime planner      | Incoming capacity intent, committed evidence, share/buffer/quote | A validated preview/refusal, canonical commands, and readiness conditions     |
| React component      | Preview, status, choice/confirmation callbacks                   | Only visualization and user choice; no env/tx/financial formulas              |
| Frontend coordinator | Intent and the confirmed plan                                    | Submission via the adapter, observing committed state, recalculation/statuses |

Receive/Swap/Lending pass the inbound intent; the component does not import these screens.
Pay uses a separate projection of the existing Move, without a credit choice.
When source capacity is insufficient, the read-only funding quote uses the same PathFinder:
it allows topping up only the chosen first Account and checks the exact fees
and the real capacity of the remaining edges. Ordinary Pay admission does not change. Move is passed
the amount including fees; after J-confirmation, the saved payment is returned for verification.
The canonical calculation is generalized in [capacity-plan.ts](../core/account/capacity-plan.ts).
This path replaces the previous swap-specific planner; there is no second financial formula in the UI.
The planner checks authority, Account identity, fee, rounding, and the permissibility of the chosen risk.
The Runtime retains ownership of the WAL/outbox; the frontend does not add a durable financial queue.
The new UI setting does not require a new AccountState field, until such a field is proven by the protocol.
One implementer owns each area; shared interfaces change in a coordinated way.
The reviewer joins after a stable diff; stand, formatting, and commit are performed sequentially.

## decisions made prior to the production implementation

Decided: the shared RECEIVE primitive, Pay → pre-filled Move → Pay confirmation,
a default of 100% collateral, shortfall, React `/ui`,
the permanent grant, collateral for a request with a timeout and a hub quote, automation and ETA up to J-finality.
Do not ask this again; the buffer applies to the entire required credit limit.
The economics of request execution and return are still being designed.
It must define the +5% margin, clock/start/expiry, the fee on refusal, griefing, release/refund, and recovery.
The first path is invoice/quote-first; a background incoming intent does not appear as a hidden UI addition.
The existing requestCollateral cannot be renamed to lease without implementing these properties.

## acceptance

| Check                  | Required evidence                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Credit direction       | RECEIVE: the user's own grant to the hub; queued/committed are distinguished; Pay does not request credit              |
| Shortfall              | Both the LEFT/RIGHT sides, zero, partial shortfall, multiple Accounts, holds, and existing unsecured credit            |
| Endpoints and rounding | 100/75/50/0%, exact buffer on/off, no hidden grant at 100%, fee gross/net/separate token                               |
| Stale evidence         | A change of policy/route/token/jurisdiction/holds between preview and submit                                           |
| Unavailable funding    | No policy, insufficient reserve, hub refusal; no hidden fallback to credit                                             |
| Async/recovery         | Crash after submit/fee/credit/J, repeated click, retry; no double charge                                               |
| Operations             | RECEIVE/swap/cross-j/lending; Borrow without a fake receive; Pay is preserved via Move and requires a new confirmation |
| Long-running execution | Partial fill/expiry/cancel do not leave unexplained risk or an eternal capacity guarantee                              |
| Browser                | Mobile/desktop, light/dark, keyboard/screen reader, console, reduced motion, ETA≠finality                              |

First the smallest failing boundary, then a production-equivalent scenario, then the overall `bun run check`.
A real React run R10 (`/tmp/xln-react-capacity-1788573224783`) verified Receive:
25 USDC → an explicit permanent grant of 27.5, and Pay→Move: 25.000025 with a fee → one batch
→ return to the available Pay without auto-sending. Startup 17.970 s, browser process 10.956 s,
0 page/MAC/auth errors and activity-view gap warnings. The run includes a fix
for the funding quote with different fees on the edges and asynchronous reading of the native transport config.
The ordinary Swap separately passed through a fresh wallet in 24.100 s with startup:
199.999992 USDC debited, 0.0799760016 WETH received, permanent limit 0.0879824 WETH,
zero pending work. Artifact: `/tmp/xln-react-swap-1788573446670/browser.log`.
The Lending browser scenario and lease execution are not yet proven.
This document does not claim financial, browser, or release readiness for the feature.

## cross receive: actual execution and fee disclosure

2026-09-05, React Cross R10: a fresh wallet, two of the user's own Entities, two real
Accounts with H1, two local EVM jurisdictions. The name `Tron` for the second network here
denotes a second Anvil; this run **does not prove native TVM**.
Test: [e2e-cross-swap.spec.ts](../ui/tests/e2e-cross-swap.spec.ts).
Artifact: `/tmp/xln-react-cross-swap-1788576931486/browser.log`;
screenshot: `/tmp/xln-cross-receive-spectrum.png`. Startup 18.820 s, browser 8.319 s,
1 pass, 0 page/MAC/auth errors. This is proof of a specific path, not a release gate.

| Check            | Actual result                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default          | Slider 0: 100% collateral; Swap is closed                                                                                                                                    |
| Explicit choice  | `Accept it as credit instead` only changes the choice to 0% collateral; assets/credit/routes do not change                                                                   |
| Separate consent | `Extend credit limit`: 0 → 11,218.878 USDT, including +10%; there is no deal before the manual Swap                                                                          |
| Real quote       | Existing MM order: 10,200 USDC@Testnet → 10,198.98 USDT@Tron                                                                                                                 |
| Starting funds   | Faucet 20,000 USDC; after the routine rebalance, 19,997.90 of own funds; the 2.10 difference is kept separately                                                              |
| Execution        | Both committed routes `settled`; source debit 10,200 USDC; gross filledTarget 10,198.98 USDT                                                                                 |
| Receipt          | Net 10,197.860102 USDT + signed rebalance fee 1.119898 USDT = gross 10,198.98 USDT                                                                                           |
| Proof of fee     | Target Account frame 6, `request_collateral`, token/feeToken 3, amount 10,198.98, policyVersion 1; root `0x3b79c0767b250511094ee279ee89aa2e01a3bd05ebf8dcc28f9b99acdd0cba8b` |
| After execution  | Debt/pending/mempool/pulls = 0 on both legs; the permanent credit limit is preserved                                                                                         |

The fee is taken from the confirmed Account frame history with a single read after execution.
This is necessary because `requestedRebalanceFeeState` is deleted after J-finality.
One's own assets are computed via `deriveDelta.outCollateral + outPeerCredit` at
`inOwnCredit = 0`; outCapacity includes someone else's credit and is not counted as a balance.
The raw collateral/ondelta/offdelta are recorded before and after the operation.

**UX/consent gap, recorded prior to the fix, in R10:** the interface did not disclose the paid
auto-rebalance after receiving. Exact strings: `You receive` — `10198.98`;
`H1 pays 10,198.98 USDT into your account there`; `Atomic · both legs or neither`.
Spectrum first states `Collateral for a future receipt is not available yet.
No fee is charged. You can explicitly choose credit, or wait for collateral support.`
After choosing credit, the permanent limit and the +10% buffer are disclosed, but not the auto-rebalance fee.
In Cross mode, the `Hub fee` block is not displayed at all: [Swap.tsx:174](../ui/src/screens/Swap.tsx#L174),
[Swap.tsx:403](../ui/src/screens/Swap.tsx#L403), [Swap.tsx:546](../ui/src/screens/Swap.tsx#L546).
The equality net + signed fee = gross by itself did not close this gap.

The already-existing UI preview of an ordinary collateral request is
`counterpartyFeePolicy` + `collateralFee` in [manage.ts:20](../ui/src/runtime/financial/manage.ts#L20),
used in [AccountDetail.tsx:260](../ui/src/screens/AccountDetail.tsx#L260).
The canonical automatic decision is `checkAutoRebalance` in
[request-collateral.ts:192](../core/account/tx/handlers/rebalance/request-collateral.ts#L192):
it accounts for the actual post-receipt `outPeerCredit`, the local policy/threshold/max fee,
an already-existing request, a pending frame, and settlement. A ready-made preview of the future
auto-rebalance specifically was not found; the manual preview cannot be presented as a guaranteed charge.

Implemented without a new financial formula: separately the gross receipt and the committed tariff
of the receiving counterparty (`baseFee`, `gasFee`, `liquidityFeeBps`), the condition for a possible
auto-charge, and a link to the existing Account collateral settings. The policy version
is stored in the test evidence and `data-policy-version`; the product-facing text does not show it.
The exact future fee/net is not promised: the size of the collateral request depends on the state
after receipt. A missing policy explicitly does not mean a zero fee. The disclosure
remains visible after Spectrum is closed. Its previous phrase `No fee is charged`
has been replaced with the precise: `This preparation submits no collateral request.` The credit choice itself
and its confirmation indeed do not send a collateral request. The financial
behavior, policy, and automatic actions have not been changed.

React Cross R12 verified these conditions before the manual Swap and repeated the exact economics of R10:
1 pass, startup 18.419 s, browser 13.178 s, 0 page/MAC/auth errors.
Artifact: `/tmp/xln-react-cross-swap-1788577815409/browser.log`.
The exact pre-Swap strings are saved in `preSwapDisclosure`, including
`Gross receive: 10198.98 USDT before fees.` and
`H1 collateral tariff: 0.1 USDT base + 0 USDT gas + 1 bps of the collateral requested.`
The UI policy version 1 matched the signed `request_collateral` in Account frame 6.
Its root: `0x3f8ca2e92ca4b041070da3922c8f250d7857d587df4dc4a3a83d7c2a04399391`.

Mobile 390×844: horizontal overflow 0 px; screenshots
`/tmp/xln-cross-receive-fees-mobile.png` and `/tmp/xln-cross-receive-fees-desktop.png`
were taken after the routine disappearance of the toast. After execution, the link genuinely opened
the receiving Account, the Collateral tab in Manage, and USDT. The balances, debt, permanent credit,
and the single cross-swap did not change upon navigation; preserving the draft on return
is not verified and is not promised.
The R12 visual check revealed a separate mobile gap: the existing sticky Swap button
overlapped the bottom disclosure link at the initial scroll position. Zero horizontal
overflow did not check for this; the link navigation in R12 was checked on desktop.

R11 revealed a test error: whole-state equality after navigation required roots/heights/collateral
to remain unchanged while an already-sent J-rebalance continued finalizing.
R12 preserves `after` and `afterSettings` in full and checks the economic invariants of the
transition. Both cross legs are terminal `settled`; the drain Account work is checked directly
after execution. The later `afterSettings.source.pending = true` shows the new
state of an already-ongoing J-rebalance, so the latest snapshot is not proof of
a complete J-drain. This browser run also does not prove native TVM or overall release readiness.

A subsequent regression on the same candidate runtime:

- Receive/Pay R13: the explicit credit choice was updated, then a separate `Extend credit limit`.
  The previous checks are preserved: 27.5 USDC limit preview, Move 25.000025, one batch,
  return to the pre-filled Pay without auto-sending. Startup 18.890 s + browser 10.599 s,
  1 pass. Artifact: `/tmp/xln-react-capacity-1788578008372/browser.log`.
- Same-J + Cross R14: one bootstrap 18.761 s, two fresh wallets/contexts in one
  sequential browser run 19.338 s, 2 pass. Same-J debited 199.999992 USDC,
  received 0.0799760016 WETH; permanent limit 0.0879824 WETH. Cross repeated the exact
  gross/net/signed-fee checks. Artifact: `/tmp/xln-react-cross-swap-1788578133651/browser.log`.
- Root removed only Swap from the existing mobile sticky selector. R14 checks the
  geometry: disclosure bottom 735.5625 px, Swap top 747.5625 px — a 12 px gap,
  horizontal overflow 0. The fresh `/tmp/xln-cross-receive-fees-mobile.png`
  visually confirms the visible text and link. The Pay/Move/Spectrum sticky behavior
  was not changed by this fix. In both runs, 0 page/MAC/auth errors.

## lending receive: the first production boundary

The incoming path of Lending is the payout upon manually closing one's own open position with no active
borrowers; [LendingClose.tsx](../ui/src/components/LendingClose.tsx) already uses the shared
Spectrum. Borrow provides outbound credit and does not transfer principal: showing
an inbound Spectrum for Borrow itself is incorrect.

The first real React Lending R1 from 2026-09-05 stopped before closing:
a fresh wallet received 200 USDC via the faucet; clicking `Offer to the pool` for 200 USDC,
1 day, 100 bps triggered a runtime fail-stop `ACCOUNT_AUTHORITY_ENTITY_STAGE_APPLY_DISCARD_FAILED`.
The hub pool remained empty. Startup 19.013 s, browser 22.158 s, exit 1; the stand was released.
Artifact: `/tmp/xln-react-lending-1788578675867/browser.log`; the full browser trace —
`/tmp/xln-react-lending-1788578675867/artifacts/e2e-lending-lending-close--e96ce-e-a-manual-committed-payout/trace.zip`.
Extracted console: `/tmp/xln-lending-r1-console.json`. The existing logging
has no nested `AggregateError.errors[]`, so the original exception is not
established by this artifact. The runtime fix belongs to a separate TS owner; the UI does not bypass the failure.

The TS owner then reproduced the original exception on a real worker:
`ACCOUNT_TX_KIND_OUT_OF_PROFILE:lending_fund`; log `/tmp/xln-lending-worker-boundary.log`.
The cause lies in the canonical admission profile, earlier than the execution of the Lending handler.
Repeating the browser run or changing Spectrum before this boundary is resolved is not required;
allowing transaction kinds must be accompanied by a check of the readiness of the TS/Rust handlers.

[e2e-lending.spec.ts](../ui/tests/e2e-lending.spec.ts) prepares a further check only
through real UI actions: lend 200, after the Account exposure disappears change
one's own grant to 1, obtain a real incoming deficit of 199 upon close, choose credit, and
separately confirm a permanent grant of 219.9 with a +10% new credit. Then a manual close,
the terminal pool state, and the exact payout. These stages **have not yet been reached or proven**.
Disclosure of the possible auto-rebalance fee before a Lending close also remains the next
condition to be verified after the first runtime boundary is fixed.
