# XLN Lend/Borrow

**Status:** required for first launch by owner instruction on 2026-09-07
(Istanbul time); implementation is not yet production-ready.

## Current implementation and accounting

The owner approved on 2026-09-07 that principal is transferred exactly once and
that the hub retains its obligation to depositors after borrower default.
`lending_disburse` now pays hub → borrower through the canonical direct-payment
handler; it never changes either credit limit. The signed `disburse:<loanId>`
intent prevents a second transfer. Repayment pays principal plus agreed interest
once, then its bilateral commit finalizes the hub book without a credit-revoke
round trip. Defaults preserve the unpaid loan and the depositor's principal claim;
a withdrawal still requires actual bilateral payout capacity.

The old revolving-credit transaction is removed. Its numeric wire tag 13 is
rejected; disbursement uses tag 24. Old credit-grant/revoke intent tags 3/4 are
rejected on restore; disbursement uses tag 7. Existing data containing the old
lending protocol requires an explicit offline migration. It must not be replayed
under the new principal-transfer semantics. Disposable local test data is reset.

Both wallets include hub-reported deposits and subtract unpaid term-loan
repayments in total balance. Example: start with 100, borrow 2 at 1% per term;
the account contains 102, the loan obligation is 2.02, and net balance is 99.98.
This projection is an estimate from the hub, not new settlement authority.

Verification commands:

- `bun run test:lending:fast`: deterministic Account/Entity scenarios, shared
  TS/Rust semantic vectors, wire rejection and signed portfolio valuation.
- `bun run test:lending:e2e`: real React and Svelte controls on `bun run dev`.
  React uses separate lender and borrower wallets and spends the proceeds before
  repayment. Svelte exercises the full fund/disburse/repay/withdraw path.
  Use a clean disposable stand; pre-existing competitive offers can change the
  selected lender, and the test must fail rather than claim the wrong payout.

Admission is open. The implementation still automatically matches offers;
manual underwriting, jurisdiction-enforceable term claims and late repayment
remain separate release requirements. The design below describes the broader
product target, not evidence that all release requirements are implemented.

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

## State Model

Hub entity state owns lending pools per asset and jurisdiction:

```ts
type LendingPool = {
  assetId: string;
  jurisdictionId: string;
  availablePrincipal: bigint;
  lentPrincipal: bigint;
  borrowedPrincipal: bigint;
  accruedInterest: bigint;
  offers: Map<string, LendingOffer>;
  loans: Map<string, LoanPosition>;
};
```

User positions are bilateral account facts against the hub:

```ts
type LendingOffer = {
  id: string;
  lenderAccountId: string;
  assetId: string;
  principal: bigint;
  termSeconds: bigint;
  annualRatePpm: bigint;
  status: 'open' | 'matched' | 'cancelled' | 'closed';
};

type LoanPosition = {
  id: string;
  borrowerAccountId: string;
  lenderAccountId?: string;
  hubEntityId: string;
  assetId: string;
  principal: bigint;
  interestDue: bigint;
  openedAt: bigint;
  maturesAt: bigint;
  status: 'active' | 'repaid' | 'defaulted' | 'cancelled';
};
```

All financial amounts and timestamps that affect settlement are `bigint`.
No `number` arithmetic is allowed in money-moving code.

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
- expired/defaulted position is visible and does not loop errors;
- same entity behavior is consistent on Testnet and Tron;
- all assertions are visible in the interface, not only logs.

## Out Of Scope For First Pass

- variable-rate pools;
- liquidation markets;
- third-party secondary loan trading;
- multihop lending routes;
- external oracle pricing.
