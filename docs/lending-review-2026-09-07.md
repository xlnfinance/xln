# Lending: existing implementation review

Reviewed on 2026-09-07 (Istanbul), main SHA `64b5f62b7` plus the existing working
tree. This is a review of the current implementation, not a release approval.
The owner now requires Lending for first launch: hub opt-in, manual underwriting,
and explicit current-balance to N-day term positions.

## Verdict and evidence

Reuse the existing Account/Entity pipeline and lending book. Do not enable its
current economics for real funds merely by removing the admission exclusion.
TypeScript and Rust implement the same important accounting problems.

| Evidence run | Result | Actual scope |
|---|---|---|
| TS lending state + API | 6/6, 46 assertions, 2.01 s | Existing internal transitions, payer/replay guards, commitment and read API |
| TS shared Account vector | 1/1, 387 ms | Six AccountTx variants against the checked-in semantic vector |
| Rust engine + entity-kernel lending_parity | 7/7, 7.90 s build | Internal Account handlers and Entity decoding; bypasses live admission |
| New accounting counterexamples | Both reproduced, 17 assertions, 109 ms | Actual Account transitions and committed Entity followups; controlled J finality input, no chain/signatures/WAL |
| Existing React lending lifecycle | Failed at lending_fund | Production rejects ACCOUNT_TX_KIND_OUT_OF_PROFILE; not rerun after the known D3 boundary |
| Full check after Solidity checkpoint | Not green | Artifact drift, storage budget and Solidity invariants15/15 now pass; next first red was compact/full Account UI types. Targeted type fix passes; the full check has not yet been rerun on it |

Logs: `docs/evidence/archive-tmp/xln-lending-existing-ts-20260907.log`,
`docs/evidence/archive-tmp/xln-lending-ts-vector-20260907.log`,
`docs/evidence/archive-tmp/xln-lending-existing-rust-20260907.log`,
`docs/evidence/archive-tmp/xln-ui-lending-principal-r1-20260907.log`,
`docs/evidence/archive-tmp/xln-ui-pay-lending-full-check-20260907.log` (historical first blocker),
`docs/evidence/archive-tmp/xln-ui-recovery-policy-full-check-r3-20260907.log` (latest full check).
Numeric counterexamples and executable reproduction:
`docs/evidence/archive-tmp/xln-lending-accounting-counterexamples-20260907.json`,
`docs/evidence/archive-tmp/xln-lending-accounting-counterexamples-20260907.test.ts`,
`docs/evidence/archive-tmp/xln-lending-accounting-counterexamples-20260907.log`.

## What exists

Four Entity commands create six bilateral Account transaction kinds. Account
handlers validate payer/proposer direction and intent replay; Hub Entity state
contains `lending.pools` and `lending.loans`, and its frame hash commits that book.
There are TS/Rust handlers, canonical wire/state codecs, fixtures, read APIs,
React and Svelte screens. No second lendbook or separate consensus engine is needed.

The implemented flow is: direct payment from lender to hub; automatic pool match;
borrower credit-limit increase; direct repayment to hub; credit-limit decrease;
cooperative payout to lender. The book is therefore not yet the owner's term-hold
and manually approved loan product.

## Findings, in implementation order

1. **Principal accounting is wrong for a credit-line loan.** Borrow grants a limit
   without transferring principal. Repay then debits principal plus interest as a
   new payment. In a zero-initial-debt example: grant100, spend100 on the
   borrower-to-hub leg, restore101 from owned funds, repay101, then revoke the
   100 grant with `creditLimit=0` leaves Account debt100 while the loan becomes
   `repaid`. Executed successfully as a bug reproduction through actual TS Account
   transitions and Entity followups; R2C is a controlled finalized-J input, not a
   chain execution; merchant forwarding was not exercised. A separate Rust
   execution of this full numeric trace is still
   pending. TS: balance/lending.ts and
   committed-lending-followup.ts:127–192,196–232. Rust: lending/followups.rs:209–248
   and engine/tx/handlers/lending/mod.rs:179. Rust lending/followups.rs:278–293
   marks the loan Repaid and credits the pool without checking remaining Account
   debt; revocation changes only the credit limit. Independent read-only review
   confirmed the numeric trace and this distinction. Live admission currently blocks it.
2. **A term claim cannot currently be collected through the jurisdiction alone.**
   Fund reduces the ordinary bilateral balance and creates a Hub Entity pool
   position. Current settlement consumes signed offdeltas and transformer clauses;
   no Lending clause maps that position back to a payable term claim. Close needs
   a new cooperative hub payout. Preserve an enforceable signed claim before
   reducing the lender's existing one. Check disputes both before and after maturity.
3. **Fund accepts borrowed capacity.** It uses ordinary direct-payment outCapacity,
   which includes unused credit. Own balance0 plus hub credit100 can create
   pool.available100 while giving the lender debt100, without new collateral or
   reserves. This second case was also executed through the actual TS handlers.
   The requested current-balance product must distinguish owned assets
   from permission to borrow; a pool counter is not proof of cash liquidity.
4. **No hub opt-in or manual approval.** `profile.isHub` activates followups;
   `selectBestLendingPool` immediately allocates a request. No signed underwriting
   decision, approval expiry, rejection queue or agency evidence is implemented.
5. **No N-day deposit maturity or default lifecycle.** Pools have a term class but
   no fixed redemption date. Loans store dueAt without an overdue/default action;
   free pools close immediately. Full exact repayment is mandatory; one repayment
   intent per loan prevents ordinary partial repayment. No loss allocation exists.
6. **Full-width totals can become unpayable.** Principal plus interest can exceed
   uint256 while one repayment must fit a uint256 token transfer. Credit plus
   principal can also exceed the credit representation after creating Opening.
   Support correct cumulative liabilities and bounded individual transfers, with
   partial repayment and explicit failed-opening handling; do not add an arbitrary
   business transfer ceiling.
7. **Expected product rejection is not a completed product flow.** Missing liquidity,
   active loans on close and insufficient payout capacity throw from followups.
   They need explicit user-visible terminal/pending outcomes, preserving financial
   state and avoiding a runtime halt for an ordinary denied request.
8. **Client boundaries need cleanup.** React API parsing turns malformed amounts
   into zero and unknown terms into 1d. Its default rate is 1% per day for 1d,
   not 1% APR. The old CLI omits required intent/term/loan fields and hides the type
   error with `as never`; its wait predicate is unconditional. The Svelte controls
   still offer actions rejected by the global profile. These are not launch evidence.

## Approved minimal target

Owner confirmed on 2026-09-07 in the soft-mainnet successor task: the hub keeps
its obligation to the depositor; principal is transferred exactly once.
The proposals below are now approved on those two points. Earlier unanswered
questions in this review are historical, not outstanding approval requests.

Keep one Hub Entity lending book, one asset/jurisdiction per book and existing
bilateral admission, signed frames, WAL and outbox. Opt-in controls new origination;
turning it off must never disable repayment, claim recovery or existing exits.

For the simplest fixed-term loan, propose actual disbursement of principal exactly
once through the existing payment path, then repayment of principal plus agreed
interest. A revolving credit line instead needs distinct drawn-debt accounting;
it cannot mix a credit-limit grant with an ordinary principal repayment debit.
This economic choice must be explicit before implementation.

Recommend preserving the hub's obligation to its term depositor. Borrower default
is first the hub's loss; insolvency can still impair recovery. A pool in which
depositors directly absorb borrower losses is a different product and requires
their explicit acceptance. Owner was asked this exact liability question.

Price new loans from funding cost, operating/settlement cost, expected credit loss,
capital/liquidity cost and hub margin. Fix accepted terms. Match loan maturities to
funding maturities with a repayment buffer, and separate liquid assets from claims.
Early exit requires available liquidity or a buyer; do not promise an instant
withdrawal from already lent funds. Maple's liquidity-dependent withdrawal queue
is a useful reference, not an implementation or solvency guarantee:
https://docs.maple.finance/maple-for-lenders/withdrawal-process.

First production proof: lender100 → signed term claim → manual hub approval →
borrower receives/spends principal → repayment → lender withdrawal. Include
double delivery, exact fee/principal conservation, no own balance, no liquidity,
expiry/default, hub offline, dispute before/after maturity, and same-wallet/runtime
recovery. Re-enable TS/Rust admission only with the agreed semantics and evidence.

## Sources inspected

TS: core/types/finance/lending.ts; core/extensions/lending.ts;
core/account/tx/handlers/balance/lending.ts; core/account/tx-validation/lending-schemas.ts;
core/account/tx/admission-policy.ts; core/entity/tx/handlers/payments/lending.ts;
core/entity/tx/handlers/account/committed-lending-followup.ts and committed-lending-close.ts;
Entity/Account types, cloning, hashing, wire validation and focused tests.

Rust: rscore/crates/engine/src/tx/handlers/lending/{mod,payment,validation}.rs;
rscore/crates/entity-kernel/src/lending/{mod,state,codec,followups,terminal}.rs;
local_financial/lending.rs; live admission, frame hashing, process decoding,
runtime restore/JSON projection and Lending test/fixture surfaces.

Product: core/api/server/entities/lending.ts and its routes; React Lending,
LendingClose and financial/lending.ts; Svelte LendingPanel; CLI lending action;
both browser suites. Settlement: jurisdictions/contracts/{Types,Account,Depository}.sol.
