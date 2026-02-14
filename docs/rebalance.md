# hub auto-rebalance spec

> V1 — 2026-02-13

## what

Hub automatically manages on-chain collateral across all bilateral accounts:
- **R→C** (reserve→collateral): deposits collateral for users with unsecured credit
- **C→R** (collateral→reserve): withdraws excess collateral where hub has net positive position

Both directions execute in a single `processBatch` on-chain. Users pay a fee for R→C.
C→R uses the existing settlement workspace flow (no new types needed).

## why

Without rebalancing, users accumulate unsecured credit (trust-backed balance).
This is fine for small amounts but risky at scale — if the hub disappears, unsecured
credit is lost. Collateral is on-chain and disputable.

The hub benefits too: earned fees cover gas costs and provide revenue. Users get
security. The network gets capital efficiency.

Reference: 2019src.txt lines 2968-3127 (rebalance_channels.ts)

---

## concepts

### bilateral state

All rebalance negotiation flows through **bilateral accountTx** frames between
user and hub. Both sides independently process each frame and must arrive at
identical state. This means:

- No randomness (no `crypto.randomBytes`)
- No external reads (no live gas price in consensus)
- All inputs must exist in shared bilateral state

### fee negotiation

The hub computes fees **server-side** using current gas prices (non-deterministic).
The result enters consensus as a fixed number in a `rebalance_quote` frame.
Both sides store the same quoted fee. Both sides verify execution against it.

The hub's fee formula is private. Only the result matters to the user.
Users judge the price, not the formula — like any market.

### quoteId = timestamp

Each quote is identified by the `env.timestamp` when its frame is applied.
Both sides process the frame → both derive the same quoteId. No random bytes.
One active quote per account at a time. New quote replaces old.

### trigger modes

- **manual**: user explicitly requests rebalance (clicks button in wallet)
- **absolute**: auto-trigger when `uncollateralizedCredit > softLimit`
  - `uncollateralizedCredit = max(0, hubDebtToUser - collateral)`
  - Ref: 2019src "uninsured balances gone beyond soft limit"
  - If `softLimit === hardLimit` → effectively manual (no auto-trigger zone)

---

## data structures

### RebalancePolicy (stored per-token in AccountMachine)

```typescript
interface RebalancePolicy {
  softLimit: bigint          // trigger when uncollateralized credit > this
  hardLimit: bigint          // max uncollateralized credit (emergency threshold)
  maxAcceptableFee: bigint   // auto-accept quotes with fee ≤ this (USDT)
}
```

Both sides see this (set via `set_rebalance_policy` accountTx).
Hub uses it to decide when to quote. User entity uses it for auto-accept.

### RebalanceQuote (stored in AccountMachine, one at a time)

```typescript
interface RebalanceQuote {
  quoteId: number       // = env.timestamp when quote frame was applied
  tokenId: number       // which token to collateralize
  amount: bigint        // collateral amount
  feeTokenId: number    // fee denomination (1 = USDT)
  feeAmount: bigint     // fee in feeToken units
  accepted: boolean     // true if auto-accepted or manually accepted
}
```

Expiry: `env.timestamp > quoteId + QUOTE_EXPIRY_MS` (5 minutes = 300,000ms).

### AccountMachine additions

```typescript
interface AccountMachine {
  // ... existing fields ...
  rebalancePolicy: Map<number, RebalancePolicy>   // tokenId → policy
  activeRebalanceQuote?: RebalanceQuote            // one at a time
  pendingRebalanceRequest?: {                      // manual request
    tokenId: number
    targetAmount: bigint
  }
}
```

---

## accountTx types (bilateral, in REA consensus)

### 1. set_rebalance_policy

Sent by: user (or hub setting its own limits)
Purpose: configure auto-rebalance thresholds

```typescript
{
  type: 'set_rebalance_policy'
  data: {
    tokenId: number
    softLimit: bigint
    hardLimit: bigint
    maxAcceptableFee: bigint
  }
}
```

Handler:
- Validates `softLimit <= hardLimit`
- Validates `maxAcceptableFee >= 0`
- Stores in `accountMachine.rebalancePolicy.set(tokenId, { ... })`

### 2. rebalance_request

Sent by: user (manual rebalance only)
Purpose: ask the hub for a quote

```typescript
{
  type: 'rebalance_request'
  data: {
    tokenId: number
    targetAmount: bigint
  }
}
```

Handler:
- Validates `targetAmount > 0`
- Stores in `accountMachine.pendingRebalanceRequest`
- Hub crontab picks this up and responds with a quote

### 3. rebalance_quote

Sent by: hub
Purpose: offer a price for rebalancing

```typescript
{
  type: 'rebalance_quote'
  data: {
    tokenId: number
    amount: bigint
    feeTokenId: number      // 1 = USDT
    feeAmount: bigint
  }
}
```

Handler:
- Replaces any existing `activeRebalanceQuote` (one at a time)
- Derives `quoteId = env.timestamp` (both sides compute identically)
- Stores quote with `accepted = false`
- **Auto-accept check** (both sides compute):
  ```
  policy = accountMachine.rebalancePolicy.get(tokenId)
  if (policy && feeAmount <= policy.maxAcceptableFee):
    quote.accepted = true
  ```
- Clears `pendingRebalanceRequest` (quote is the response)

### 4. rebalance_accept

Sent by: user (only when auto-accept didn't trigger)
Purpose: manually approve a quote that exceeds maxAcceptableFee

```typescript
{
  type: 'rebalance_accept'
  data: {
    quoteId: number       // must match activeRebalanceQuote.quoteId
  }
}
```

Handler:
- Validates quote exists: `accountMachine.activeRebalanceQuote != null`
- Validates quoteId matches
- Validates not expired: `env.timestamp <= quoteId + 300_000`
- Sets `quote.accepted = true`

---

## entityTx: deposit_collateral (enhanced)

Existing `deposit_collateral` entityTx gains optional fee fields:

```typescript
{
  type: 'deposit_collateral'
  data: {
    counterpartyId: string
    tokenId: number
    amount: bigint
    // NEW — optional, for rebalance fee collection:
    rebalanceQuoteId?: number
    rebalanceFeeTokenId?: number
    rebalanceFeeAmount?: bigint
  }
}
```

When `rebalanceQuoteId` is present, the handler additionally:
1. Looks up `activeRebalanceQuote` in the bilateral account
2. Verifies: `quote.quoteId === rebalanceQuoteId`
3. Verifies: `quote.accepted === true`
4. Verifies: `quote.feeAmount === rebalanceFeeAmount`
5. Verifies: not expired (`env.timestamp <= quoteId + 300_000`)
6. Deducts fee: shifts offdelta in `feeTokenId` delta (user→hub)
7. Clears `activeRebalanceQuote`

**Non-atomic caveat:** The fee is collected immediately via bilateral offdelta shift,
but the collateral deposit is queued for on-chain batch execution. If the batch fails,
the fee has already been collected. V2 will defer fee to post-settlement confirmation.
If quote verification fails, the deposit is rejected (fee not collected).

### expired/invalid quote at execution time

If hub attempts `deposit_collateral` with a `rebalanceQuoteId` that is expired
or no longer valid (quote replaced, already executed, etc.):

1. The deposit is rejected (frame fails validation)
2. If the user already paid a fee (e.g. via a separate offdelta movement),
   the hub MUST return the payment with reason `QUOTE_INVALID`
3. Hub sends a new `rebalance_quote` with updated fee for the user to re-accept

The user is never charged for a failed rebalance. The quoteId acts as a
receipt — if the receipt doesn't match, the transaction is void.

---

## flows

### auto-rebalance (happy path, fee within policy)

```
precondition: user previously set policy via set_rebalance_policy
              user's collateral drops below softLimit

hub crontab (server-side, every 30s):
  1. Detects: collateral < softLimit
  2. Computes fee from current gas price (server-side, non-deterministic OK)
  3. Checks: fee ≤ user's maxAcceptableFee (from bilateral state)

frame 1 — hub proposes rebalance_quote (accountTx):
  → Both sides store quote, auto-accept triggers (fee within policy)
  → quote.accepted = true

frame 2 — hub proposes deposit_collateral (entityTx):
  → Includes rebalanceQuoteId + fee fields
  → Both sides verify quote accepted + fee matches
  → Fee deducted bilaterally, collateral queued for on-chain batch
  → Quote cleared

total: 2 frames, 0 user interaction
```

### auto-rebalance (fee exceeds policy)

```
frame 1 — hub proposes rebalance_quote:
  → Auto-accept check fails (fee > maxAcceptableFee)
  → quote.accepted = false
  → User sees quote in wallet UI

frame 2 — user sends rebalance_accept:
  → Manual override, user explicitly approves higher fee
  → quote.accepted = true

frame 3 — hub proposes deposit_collateral + fee:
  → Atomic execution

total: 3 frames
```

### manual rebalance (user-initiated)

```
frame 1 — user sends rebalance_request:
  → "I want $5000 USDC collateral"
  → Stored as pendingRebalanceRequest

frame 2 — hub responds with rebalance_quote:
  → Hub computes fee based on current gas
  → Auto-accepted if within maxAcceptableFee

frame 3 — hub proposes deposit_collateral + fee:
  → Atomic execution

total: 3 frames (or 4 if fee needs manual accept)
```

### quote expiry

```
frame 1 — hub proposes rebalance_quote:
  → quoteId = env.timestamp = T

... 5 minutes pass, no accept, no deposit ...

hub crontab:
  → Checks: env.timestamp > T + 300_000 → expired
  → Sends new rebalance_quote with updated fee
  → Old quote replaced
```

---

## hub crontab logic (server-side, outside consensus)

### matching strategy (configurable)

Hub operator configures the matching/priority strategy:

```typescript
interface HubRebalanceConfig {
  matchingStrategy: 'hnw' | 'fifo'
  // ...other hub config
}
```

- **hnw** (high net worth first, default): sort netReceivers by amount descending.
  Biggest requests served first. Optimizes gas per dollar. 2019 pattern.
- **fifo** (first in, first out): sort netReceivers by quoteId ascending.
  Oldest accepted quotes served first. Fair but less gas-efficient.

Both are valid strategies. HNW maximizes capital efficiency. FIFO maximizes
fairness. Hub operator chooses based on their business model.

### crontab pseudocode

```
every 30 seconds:
  collect all accounts with accepted quotes or policy triggers

  sort by matchingStrategy:
    hnw:  sort by amount descending (biggest first)
    fifo: sort by quoteId ascending (oldest first)

  for each account (in sorted order):
    for each token with rebalance policy:
      if softLimit === hardLimit: skip (manual mode)
      if collateral >= softLimit: skip (healthy)

      // Check for accepted quote → execute
      if activeQuote exists AND accepted AND not expired:
        submit deposit_collateral frame with fee fields
        continue

      // Check for pending request → send quote
      // OR collateral below softLimit → send quote
      if hub reserves < needed: skip (insufficient liquidity)
      compute fee from current gas (server-side)
      submit rebalance_quote frame
```

---

## fee model

### hub computes fee server-side

```
fee = baseFee + gasCost + liquidityFee

baseFee:       flat per operation (e.g. $2 USDT)
gasCost:       gasEstimate * gasMarkup (e.g. $1.20 * 1.5 = $1.80)
liquidityFee:  amount * liquidityBPS / 10000 (e.g. $5000 * 10/10000 = $5)

example: $2 + $1.80 + $5 = $8.80 total
```

The formula is private to the hub. Users see only the quoted feeAmount.
Hubs compete on fees. Users set maxAcceptableFee as their ceiling.

### hub gossip advertisement (informational, not authoritative)

Hub's gossip profile can include indicative fee info for wallet UIs:

```typescript
profile.metadata.rebalanceFees = {
  baseFeeUSDT: '2000000',         // $2
  liquidityFeeBPS: 10,            // 0.1%
  currentGasEstimateUSDT: '1200000', // $1.20
  updatedAt: 1707800000
}
```

This is for display only. The authoritative fee is in the bilateral `rebalance_quote`.

### fee deduction mechanism

Fee is deducted by shifting offdelta in the fee token's delta:

```
before: user USDT offdelta = +100
fee = $8.80

after: user USDT offdelta = +91.20 (hub gained $8.80)
```

Both sides compute identically because the feeAmount comes from the stored quote.

---

## determinism guarantees

| component | deterministic? | why |
|-----------|---------------|-----|
| quoteId | yes | = env.timestamp, both sides identical |
| feeAmount | yes | stored in bilateral quote, both sides read same value |
| auto-accept | yes | compares stored fee vs stored maxAcceptableFee |
| expiry check | yes | compares env.timestamp vs stored quoteId + constant |
| fee deduction | yes | stored feeAmount applied to shared offdelta |
| gas price read | n/a | server-side only, never in consensus |

---

## validation rules

1. `set_rebalance_policy`: softLimit ≤ hardLimit, maxAcceptableFee ≥ 0
2. `rebalance_request`: targetAmount > 0, targetAmount ≤ hardLimit
3. `rebalance_quote`: amount > 0, feeAmount ≥ 0
4. `rebalance_accept`: quote exists, quoteId matches, not expired
5. `deposit_collateral` (with fee): quote exists, accepted, not expired,
   feeAmount matches, sufficient hub reserves

---

## files

| file | change |
|------|--------|
| `runtime/types.ts` | RebalancePolicy, RebalanceQuote, AccountMachine fields, accountTx types |
| `runtime/account-tx/apply.ts` | wire 4 new handlers |
| `runtime/account-tx/handlers/set-rebalance-policy.ts` | new handler |
| `runtime/account-tx/handlers/rebalance-request.ts` | refactored from request-quote |
| `runtime/account-tx/handlers/rebalance-quote.ts` | refactored from quote-response |
| `runtime/account-tx/handlers/rebalance-accept.ts` | refactored from fee-payment |
| `runtime/entity-tx/handlers/deposit-collateral.ts` | enhanced with fee collection |
| `runtime/entity-crontab.ts` | execution logic: quote→deposit flow |

---

## C→R flow (collateral→reserve via settlement)

### when does hub withdraw?

Hub has excess collateral when its net position is positive (user owes hub).
This is idle capital that can be recycled to fund R→C deposits elsewhere.

```
totalDelta = ondelta + offdelta
hubIsLeft:  hubDebt = max(0, -totalDelta)   // hub pays when delta < 0
hubIsRight: hubDebt = max(0, totalDelta)    // hub pays when delta > 0

excess = collateral - hubDebt  (if excess > 0, hub can withdraw)
```

### settlement workspace lifecycle

C→R reuses the existing settlement system. No new AccountTx types needed.

```
1. Hub crontab detects excess → generates settle_propose EntityTx
     → creates settlementWorkspace with C→R diffs
     → workspace.status = 'awaiting_counterparty'

2. Counterparty auto-approves (inline, during processSettleAction):
     → canAutoApproveWorkspace() checks diffs are safe
     → signs settlement hanko via signHashesAsSingleEntity()
     → workspace stores counterparty hanko (leftHanko or rightHanko)

3. Hub crontab detects counterparty hanko → generates settle_execute EntityTx
     → batchAddSettlement() adds to jBatch with counterparty hanko only
     → batch-level hanko covers Hub authorization on-chain
     → workspace.status = 'submitted' (NOT deleted yet)

4. On-chain processBatch executes → emits AccountSettled event

5. j_event_claim processes event → tryFinalizeAccountJEvents():
     → detects workspace with signed hanko(s)
     → increments onChainSettlementNonce
     → activates post-settlement dispute proof
     → deletes workspace (cleanup)
```

Key design: Hub does NOT sign its own settlement hanko. On-chain reads:
- **Batch-level hanko** for Hub authorization (covers all operations)
- **Per-settlement hanko** for counterparty authorization (one per C→R)

### workspace status transitions

```
draft → awaiting_counterparty → submitted → (deleted by j-event)
                                    ↑
                  counterparty hanko stored inline
```

The `submitted` status prevents premature deletion. The workspace must survive
until the on-chain event confirms execution, at which point the nonce increments
and the workspace is cleared by `tryFinalizeAccountJEvents`.

---

## hub crontab: 3 processes

The hub crontab runs 3 processes in order:

### process 1: detect C→R targets

```
for each bilateral account:
  compute excess collateral (collateral - hubDebt)
  if excess > threshold AND no active settlementWorkspace:
    generate settle_propose EntityTx with C→R diffs
    → counterparty auto-approves inline (signs hanko)
```

### process 2: execute C→R settlements

```
for each bilateral account:
  if settlementWorkspace exists:
    check counterparty hanko is present
    generate settle_execute EntityTx
    → adds to jBatch (collateralToReserve[])
```

### process 3: execute R→C deposits (with effective reserve)

```
effectiveReserve = actualReserve + sum(signed C→R amounts in pending jBatch)

for each bilateral account:
  compute uncollateralizedCredit = max(0, hubDebt - collateral)
  if uncollateralizedCredit > softLimit:
    if accepted quote exists and not expired:
      generate deposit_collateral EntityTx
      → adds to jBatch (reserveToCollateral[])
    else:
      send rebalance_quote if no active unexpired quote
```

**Effective reserve:** When computing whether hub can afford R→C deposits,
C→R withdrawals in the same batch are counted as "almost available" reserve.
This enables recycling excess from one account to fund deposits for another
in a single processBatch.

---

## defaults

```typescript
const REFERENCE_TOKEN_ID = 1                     // USDC (18 decimals in registry)
const DEFAULT_SOFT_LIMIT = 500n * 10n ** 18n     // $500
const DEFAULT_HARD_LIMIT = 10_000n * 10n ** 18n  // $10,000
const DEFAULT_MAX_FEE = 15n * 10n ** 18n         // $15
const QUOTE_EXPIRY_MS = 300_000                  // 5 minutes
```

---

## future (V2+)

- **relative policy**: target % of capacity, with hysteresis band
- **deferred fee**: collect fee after on-chain settlement confirms (true atomicity)
- **batch settlement**: pack multiple deposits into one L1 tx (gas efficiency)
- **cross-hub rebalance**: hub requests collateral from another hub
- **dynamic fee tiers**: VIP rates for high-volume users
- **non-USDT fees**: accept fee payment in other tokens with price conversion
