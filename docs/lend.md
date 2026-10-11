# XLN Lend/Borrow

**Status:** restored to launch scope by the owner's latest 2026-10-11 instruction;
implementation is not yet production-ready. TypeScript, React and Ethereum same-J
are the release paths; Rust and the Svelte wallet remain frozen.

The product has two actions: **Save with a bank** (lend to the bank Entity for
agreed interest) and **Borrow from a bank**. These create separate bilateral
Account obligations. The bank owes its saver even when its borrower defaults.
Users should not need to understand internal funding-allocation labels.

Owner clarification (2026-10-11): funding belongs to the bank's common pool for
the asset and jurisdiction, never to a matched saver/borrower pair. A loan must
not identify a saver position. Savings liabilities and borrower receivables
have independent terms; borrower collections and defaults must not change a
saver's signed claim. Account payment capacity and secured recovery still follow
the individual bilateral Account, not an invented globally spendable balance.

The canonical book now stores independent `savings` and `loans`. The direct
saver matcher and per-saver allocation counters are removed. The regression
`bank liquidity combines two saver deposits without assigning either saver to
the loan` covers both 100 and 150 draws against two 60 deposits. The bank's
existing signed facility permits the exposure; Account settlement still enforces
capacity. Portfolio principal totals are claims, never spendable cash. Old books
containing saver allocations reject on restore; no silent conversion is allowed.

Owner decisions (2026-10-11): both fixed-term and on-demand savings at launch;
lending above deposits is allowed by the bank's signed risk policy; insufficient
liquidity queues payments by due date then request admission order, preserving
unpaid debt and separate Account collateral; early loan repayment charges actual
elapsed time; partial repayments pay interest then principal; a preapproved
borrower facility authorizes automatic draws. The existing authenticated facility
is the bank's bounded exposure policy: do not add a second lending permission or
global funding cap. Demand terms remain implementation work. Early and partial repayment share the signed accrual
checkpoint used by unilateral exit; the current transformer ABI carries it.

Implementation principle: prefer deletion and one general signed-obligation
mechanism across products. Product differences are explicit terms, not separate
balance engines. Financial correctness, deterministic recovery and enforceable
claims remain mandatory.

## Module ownership

Paybook (`core/paybook/`), Swapbook (`core/swapbook/`) and Lendbook
(`core/lendbook/`) own the three Entity-level products. They use the same Account
admission, balances, bilateral signatures and dispute machinery. Lendbook owns
bank terms/facilities, independent liabilities/receivables and withdrawal servicing;
the Account owns executable covenants and money movement. Transaction handlers
translate user commands and committed Account inputs into that book. There is no
second lending balance engine or saver-to-borrower allocation.

A signed close request changes its savings position from `open` to `queued`,
even when the Account cannot pay. `updatedAt` freezes the requested quote;
`closeOrder` preserves the first admission order when timestamps tie across
Accounts. The order belongs to the bank's root-bound position: funding order and
timestamps cannot reconstruct it after a crash. No separate durable queue or
retry counter is stored. Duplicate requests preserve both quote and order.

After inbound Accounts and book work, withdrawals are selected by due time,
then request order. Early cancellation is due when requested. Capacity is local
to each Account/asset: an unavailable lane keeps its oldest request, while another
independently payable lane may proceed. New borrower draws cannot jump ahead of
a queued withdrawal on the same Account/asset. One payout per idle Account uses
normal local admission; pending proposals/mempools prevent duplicate scheduling.
Only committed payout closes the debt. Rejected or interrupted proposals leave
the position queued. Old `closing` books reject on restore instead of inventing
missing request priority. The UI accepts withdrawal requests without capacity
and keeps queued claims in portfolio value.

Demand-rate direction (owner delegated, 2026-10-11): a prospective variable rate,
actual-time earnings and withdrawal without losing earned interest. Existing
earnings cannot be repriced. This follows the variable-rate savings model described
in [CFPB Regulation DD](https://www.consumerfinance.gov/rules-policy/regulations/1030/4/),
not a claim that XLN is a US regulated or insured deposit. The exact signed
rate-update/renewal mechanism and its unilateral proof remain release work.

## Current implementation and accounting

The owner approved on 2026-09-07 that principal is transferred exactly once and
that the hub retains its obligation to depositors after borrower default.
`lending_disburse` now pays hub → borrower through the canonical direct-payment
handler; it never changes either credit limit. The signed `disburse:<loanId>`
intent prevents a second transfer. Repayment settles earned interest before
principal, then its bilateral commit updates the hub book without a credit-revoke
round trip. Defaults preserve the unpaid loan and the depositor's principal claim;
a withdrawal still requires actual bilateral payout capacity.

The saver now has an independent term return: at maturity the bank owes the
original principal plus the deposit's agreed term interest, even with no matched
borrower or with loans still active. Borrower interest belongs to the bank.
Early cancellation is independent of borrower loans and does not earn the
fixed-term deposit coupon. Closing fixes the payout amount; subsequent borrower repayment or
default cannot change that payout or recreate a paid position. Actual Account
payout capacity remains necessary; this is a debt obligation, not a guarantee
that an insolvent bank can pay.

Savings and borrower loans now share a signed executable term covenant in the
existing Account subcontract tree. Funding transfers principal once and commits the asset, creditor side, principal,
rate, accrual checkpoint and Account-frame clock. The stock DeltaTransformer realizes principal
plus accrued simple interest at unilateral exit. Savings stop at the term coupon;
loans stop at their individually signed late-interest end and maximum amount.
Accrual freezes at dispute start; delaying finalization earns nothing extra. An
early cooperative cancellation can waive earned interest through the bilateral
payout. That payout removes the same claim atomically; a smaller-than-principal
payment or a different asset cannot erase it. The bank portfolio uses the signed
Account clock, not a later Entity observation time.

Disbursement includes the exact term, rate and `lateMs` in the Account transaction.
Bank policy publishes `loanLateMs`; the borrower request signs `maxLateMs` alongside
its maximum rate. The bank cannot exceed either authorization. Savings sign zero
late duration and keep their independent fixed return. No interest compounds.

For remaining principal `P`, signed rate `r` basis points per term `T`, accrued
whole interest `A`, carried numerator `R`, and time `e` since the signed accrual
checkpoint, let `D = 10,000 * T` and `N = P * r * e + R`. The outstanding claim is
`P + A + floor(N / D)`. Clamp the clock at the original opening plus `T + lateMs`;
neither partial payment nor default resets that endpoint. Initially `A = R = 0`.
There is no minimum one-unit coupon: rounding down cannot raise the signed rate.
Cooperative repayment and dispute use this same rule. Dispute execution freezes
the clock at dispute start. All sums and clock endpoints are range checked.

Repayment `amount` is the borrower's signed **maximum debit**. The Account pays only
the lesser of that maximum and the amount due at its committed frame timestamp.
Pay whole accrued interest first, then reduce principal. A partial payment keeps
the same covenant with the new principal, timestamp, unpaid interest and `N % D`.
The carried fraction prevents repeated small payments from erasing interest;
unpaid interest never compounds. Only full repayment deletes the claim. The bank
books that same Account timestamp, even if its Entity has observed a later clock.
React accepts a partial amount or a blank input for full repayment. Its full quote
uses the remaining maximum, without subtracting historical payments again.

Each `lending_repay` signs `claimHash`, the exact preceding covenant. Reusing it
after a partial payment rejects before moving money; no per-payment durable
receipt is added. The Account frame already authenticates payer, asset and claim.
The TS worker tuple now has seven fields. Old tuples and old coupon-only claims
reject loudly; deployment requires the synchronized transformer and ABI.

The Account owns the rate, original end and accrual checkpoint in its existing
root-bound subcontract. The bank retains the same fields in its committed
servicing book. Remaining principal alone cannot reconstruct previously earned
interest or fractional carry after a crash without a history scan. Cold restore
validates the fields; the real six-process, five-SIGKILL regression preserves a
nonzero fraction, later repayment and duplicate outbox delivery. Bank facilities
count remaining principal, so principal repayment replenishes the approved line.

Dispute finality retires every old-epoch subcontract and records `dispute-close`
in the existing lending receipt tree. It never invents a `repay` or `close-payout`.
The bank book marks affected positions/loans `disputed`; authenticated reserve and
debt events own subsequent recovery. A saver exit does not erase a different
borrower's receivable. Retired capital cannot fund another loan or a second payout,
and a stale HTTP portfolio cannot restore it in the wallet's lending estimate.

Savings, ordinary debt and pending spending share the existing signed credit limit.
Admission reserves the full promised term-plus-late coupon and checks pending collateral withdrawals;
it never treats opposite unearned interest as collateral. Lowering a limit remains
prospective and does not erase the claim or prevent a collateral top-up. This is
Account risk enforcement. Bank approval is a separate authenticated Entity policy.

Current implementation also checks bank-published saver/borrower rates and a named,
unexpired borrower facility bound to the Account jurisdiction and J nonce. Revoking
or exhausting the facility stops new allocations without erasing signed claims.
The saver receives the published savings coupon; borrower interest belongs to the
bank and can differ. Configuration uses authenticated bank Entity commands. React Bank administration
lets the signed-in bank publish rates, approve a named Account facility and revoke
new draws; it displays committed policy and its expiry. A real remote-owner browser
journey verifies all three actions. Ordinary borrower wallets do not show the panel. The React borrower now sees
processing, not-funded, opening and committed loan status, derived from the current
bank Account receipt and loan book. A request nonce scopes the response so a stale
HTTP response cannot describe a newer request as funded. This creates no durable
request-status ledger and scans no Account history.

Wire cutover: the Account borrow row has ten fields; disbursement has thirteen.
The late duration is also signed into the stock transformer ABI and native claim.
Old pending rows and native claims missing explicit late terms reject loudly;
never insert a default into previously signed state. Deploy this schema into a
fresh jurisdiction domain. Existing obligations on an older deployment must use
their original signed proof and transformer; this change cannot grant them new
interest. The changed Account and Entity rows have independent byte fixtures.
Rust is frozen and these fixtures make no Rust parity claim.

Each draw requires an earlier borrower-signed request with exact bank, borrower,
asset, principal, term, maximum rate, maximum late duration and expiry. Its authorization commitment lives
in the existing Account lending-intent tree, bound to jurisdiction and J nonce.
Funding consumes it atomically with payment and covenant creation, so a fresh loan
ID cannot draw twice. The request ID remains consumed after expiry or funding.
The React wallet signs a five-minute request; reducers use only the signed deadline
and controlled frame clock. A timeout cannot erase an already signed disbursement.

A saver can retry a committed close request after a temporary liquidity constraint;
the active covenant and single-use payout receipt prevent duplicate withdrawal.
Authenticated J finality also retires an opening loan reservation when the old
Account epoch ends, without pretending principal was paid or recovered.

Current late-interest evidence includes 40 production-Depository settlement cases
covering both directions, offline debtors, collateral shortfalls, capped accrual
and duplicate finalization. Focused Account/Entity tests cover cold restore,
late repayment after saver withdrawal, maximum debit, full risk reservation and
strict peer-ingress fields. EVM time advances and controlled Account clocks are
not a public real-clock recovery drill. Current browser, replay, gas and source
results are recorded in [the evidence file](evidence/crisis-20261011.json).
Historical 130/132-frame recordings predate this ABI and cannot validate it.
Public deployment, live recovery evidence and the full release gates remain open.

## Credit policy and loan authority

A hub acts as the depositor's debtor and the borrower's creditor. Its deposit
liability survives a borrower default. A loan never allocates a named deposit.
The hub must distinguish cash available to pay withdrawals, performing loan
claims, overdue claims and losses; a receivable is not withdrawal liquidity.

Use an approved facility, followed by automatic draws within that facility:

1. The hub's authorized credit officer or board approves a named borrower,
   asset and jurisdiction, principal funding cap, permitted terms and
   approval expiry. The Account credit limit separately bounds unsecured risk. First release uses explicit approval. A future automated
   underwriter must have the same bounded, signed delegation; an offer match
   alone never approves credit.
2. Before disbursement, the borrower and hub commit the exact loan covenant
   bilaterally: principal, maturity, interest calculation, payment allocation,
   late-interest terms, maximum amount due and relevant collateral allocation.
   Bind it to the parties, Account, jurisdiction, asset, loan id and nonce.
3. Admission checks the whole borrower exposure, outstanding and reserved draws,
   the hub's available liquidity and its own portfolio limits. A credit limit is
   maximum accepted unsecured risk, not promised funding or guaranteed repayment.
   Interest and outstanding ordinary Account debt must not create an uncounted
   second credit line. A policy limit belongs to the risk-taking hub, not a global
   protocol ceiling on other users' money.
4. Transfer principal once through the existing canonical payment path, after
   both the covenant and approval are committed. Cancellation before commitment
   transfers nothing; duplicate delivery cannot pay twice. Every accepted draw
   retains the exact approval authority and covenant that authorized it.
5. Show maturity, delinquency, remaining claim, allocated collateral and repayment
   history. Stopping new draws does not erase existing debt or prevent repayment.
   Restructuring needs a newly agreed covenant and nonce; it cannot silently reset
   the original obligation or make the depositor whole without a real payment.

This separates credit approval from execution without requiring a human click
for every draw. The design follows the emphasis on approval authority, exposure
limits and ongoing monitoring in the [Basel credit-risk principles](https://www.bis.org/bcbs/publ/d595.pdf)
and [EBA loan-origination guidance](https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/credit-risk/guidelines-loan-origination-and-monitoring?version=2020).
It does not claim that a protocol implementation makes a hub a licensed bank.

## Maturity, default and late repayment

Selected default for the first term product: fixed agreed term interest; after
maturity, simple interest on unpaid principal at the ordinary contracted rate,
only where the original covenant explicitly authorizes it. Do not compound unpaid
interest, invent a penalty after default or apply a changed rate retroactively.
The signed covenant specifies a late-accrual end and maximum amount due, allowing
the lender to bound its risk before lending. These are loan terms, not arbitrary
protocol monetary caps. Exact rounding and partial-payment allocation belong to
that one covenant calculation, shared by quote, TS and jurisdiction execution.

`defaulted` must remain repayable. A late payment reduces the outstanding claim
exactly once and updates actual hub liquidity; it does not pretend the missed
payment arrived on time. Accrued income, cash collected and recoverable collateral
remain separate quantities. Only the allocated collateral-backed entitlement is
secured; an executable signed debt claim cannot manufacture a solvent borrower.

Jurisdiction settlement must enforce the signed maturity/default covenant even
when the borrower or hub is offline. Fit the covenant into the existing signed
Account proof and transformer mechanism, with explicit gas admission and nonce
consumption. Do not add a second loan settlement authority or debit principal
again when realizing the repayment claim. Until this path passes contract,
TS, restart and React wallet lifecycle tests, lending still blocks release.

## Product Shape

XLN should expose a separate **Lending** tab where a user can either:

- lend idle balance to a hub for a fixed term;
- request a fixed-term loan from a hub;
- view active loans, maturity, interest, collateral, and repayment status.

Initial terms:

- 1 hour
- 1 day
- 1 month

The first release should keep the flow intentionally bank-like and predictable:
quote, accept, locked principal, accrued interest, repayment, closed receipt.

## State ownership

Current structures live in `core/types/finance/lending.ts`; the hub owns the
portfolio and the Account owns bilateral financial authority. Extend those
canonical paths with the agreed covenant, not the former illustrative types in
this document. Money uses exact integer arithmetic and timestamps use the units
and checked ranges required by [FinTS](fints.md). Retained approval/covenant fields
must satisfy the existing ownership, commitment and recovery requirements.

## First Executable Flow

1. User opens Lending tab.
2. User chooses hub, asset, term, principal, and rate.
3. UI shows a deterministic quote: principal, interest, maturity, and total due.
4. User submits a lending offer or borrow request.
5. Runtime commits the account/entity tx.
6. Hub pool updates.
7. Position appears in both user and hub views.
8. Repayment closes the position and releases principal plus interest.

Expected no-liquidity or insufficient-capacity cases are terminal product
states, not fatal runtime errors. Unexpected state contradictions are fatal with
a full debug payload.

## UI Requirements

- The tab is named **Lending**.
- It has two modes: **Lend** and **Borrow**.
- Term selection is a segmented control: `1 hour`, `1 day`, `1 month`.
- Principal and rate inputs show exact asset/jurisdiction context.
- Active positions table shows term, maturity, principal, interest, status, and
  available actions.
- Hub view shows pool capacity, utilization, active loans, and open offers.

## E2E Bar

Implement only with tests that prove the full lifecycle:

- user lends to hub for each initial term;
- user cancels an unmatched lending offer;
- user borrows from hub liquidity;
- user repays before maturity;
- insufficient hub liquidity is a clean terminal UI state;
- overdue/defaulted position remains visible and accepts late repayment;
- refused or expired approval moves no principal, and concurrent draws cannot
  exceed the approved aggregate exposure;
- partial/late payments, restart and duplicate delivery preserve exact debt,
  interest, collateral allocation and the depositor's independent claim;
- offline counterparties cannot prevent jurisdiction execution of the covenant;
- same entity behavior is consistent on Ethereum testnet and mainnet;
- all assertions are visible in the interface, not only logs.

The Runtime crash regression creates saver and borrower Accounts through real
commands and signed Account consensus, persists an active loan, then SIGKILLs
through overdue processing, saver withdrawal, repayment and a capped unrelated
frame. Recovery reads LevelDB and WAL; saved assertion evidence is never an input
to restoration. A recovered or duplicate ACK must preserve both Account roots,
debit repayment once and leave the closed saver position unchanged. Its controlled
clock proves Runtime recovery, not public-chain real-time maturity or availability.

## Out Of Scope For First Pass

- variable-rate pools;
- liquidation markets;
- third-party secondary loan trading;
- multihop lending routes;
- external oracle pricing.
