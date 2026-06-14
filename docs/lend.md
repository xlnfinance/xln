# XLN Lend/Borrow

**Status:** design target, not part of the current production gate.

This document parks the Lending workstream outside the swap/release TODO so the
current production baseline can stay focused on direct payments and direct
same-chain/cross-chain swaps.

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

