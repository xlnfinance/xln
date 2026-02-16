# custody balance spec

> V1 — 2026-02-16

## what

A per-account, per-token balance that the user deposits voluntarily
but the hub can spend unilaterally (no user signature required).

Think of it as a "gas tank" or "prepaid service credit" that covers:
- rebalance fees (R→C on-chain gas + hub markup)
- routing fees (HTLC forwarding)
- monthly account maintenance (if any)

The user tops it up. The hub draws from it. Both sides track the balance
in bilateral state (deterministic, auditable, disputable).

## why

Without custody, every fee requires a bilateral frame (both sign).
If the user is offline, the hub cannot:
- collect rebalance fees → won't rebalance → funds stay unsecured
- collect routing fees → won't forward HTLCs → payments fail

Custody solves this: user pre-authorizes a pool of funds.
Hub deducts as needed. User sees itemized deductions on next sync.

## concepts

### bilateral state addition

```typescript
// Added to AccountMachine (per-account)
interface AccountMachine {
  // ... existing fields ...
  custody: Map<number, bigint>;  // tokenId → custody balance
}
```

### key properties

1. **User deposits voluntarily** — `deposit_to_custody` accountTx (requires user sig)
2. **Hub withdraws unilaterally** — `hub_custody_debit` accountTx (hub sig only)
3. **User withdraws anytime** — `withdraw_from_custody` accountTx (requires user sig)
4. **Deterministic** — both sides compute identical custody state
5. **Auditable** — every debit has a reason string in the frame
6. **Disputable** — custody balance is part of the account proof body

### conservation law

```
bilateral_balance + custody_balance + collateral = constant
```

Custody is OFF-CHAIN (not in Depository contract). It's purely bilateral state.
If the hub disappears, unsettled custody is lost (same risk as unsettled credit).

## accountTx types

### 1. deposit_to_custody

User moves funds from bilateral balance → custody.
Requires user signature (normal bilateral frame).

```typescript
{
  type: 'deposit_to_custody',
  data: {
    tokenId: number,
    amount: bigint,  // must be > 0
  }
}
```

Effect on delta:
- `offdelta` shifts to reduce user's bilateral balance
- `custody[tokenId]` increases by amount

### 2. withdraw_from_custody

User moves funds from custody → bilateral balance.
Requires user signature (normal bilateral frame).

```typescript
{
  type: 'withdraw_from_custody',
  data: {
    tokenId: number,
    amount: bigint,  // must be <= custody[tokenId]
  }
}
```

Effect:
- `custody[tokenId]` decreases by amount
- `offdelta` shifts to increase user's bilateral balance

### 3. hub_custody_debit

Hub deducts from custody. **No user signature required.**
Hub can include this in any frame it proposes.

```typescript
{
  type: 'hub_custody_debit',
  data: {
    tokenId: number,
    amount: bigint,       // must be <= custody[tokenId]
    reason: string,       // human-readable: "rebalance_fee", "routing_fee", etc.
    referenceId?: string, // optional: txHash, lockId, quoteId for audit trail
  }
}
```

Effect:
- `custody[tokenId]` decreases by amount
- Hub's bilateral balance increases (offdelta shift)
- Reason logged in frame for user audit

### 4. auto_custody_topup (optional, V2)

Automatic refill: when custody drops below `minCustody`, 
move from bilateral balance to custody up to `targetCustody`.

```typescript
{
  type: 'auto_custody_topup',
  data: {
    tokenId: number,
    minCustody: bigint,     // trigger when below this
    targetCustody: bigint,  // refill to this amount
  }
}
```

## flows

### user tops up custody

```
user opens account → default custody = $0
user clicks "Fund Custody" in UI → deposit_to_custody $50
hub processes frame → custody[USDC] = $50

hub does rebalance → hub_custody_debit $2 (reason: "rebalance_fee:R2C:$500")
custody[USDC] = $48

user sees in frame history:
  Frame #42: hub_custody_debit $2.00 USDC — "rebalance_fee:R2C:$500"
```

### hub rebalances with fee

```
1. Hub crontab: uncollateralized $800 > softLimit $500
2. Hub checks: custody[USDC] >= rebalanceFee ($2)? YES
3. Hub adds R→C to jBatch (amount: $800)
4. Hub proposes frame with hub_custody_debit ($2, "rebalance_fee")
5. User processes frame (or accepts on next sync)
6. On-chain: processBatch → collateral updated
7. Custody: $48 → $46
```

### user is offline

```
1. Hub crontab: uncollateralized $800 > softLimit $500
2. Hub checks: custody[USDC] >= rebalanceFee ($2)? YES
3. Hub adds R→C to jBatch
4. Hub creates frame with hub_custody_debit
   → Hub can sign UNILATERALLY (custody debit doesn't need user sig)
   → Frame queued for user to ACK on next connect
5. On-chain settlement proceeds immediately
6. User comes online → sees custody debit in frame history → ACKs
```

### custody insufficient

```
1. Hub crontab: uncollateralized $800 > softLimit $500
2. Hub checks: custody[USDC] = $0.50, fee = $2. INSUFFICIENT.
3. Hub does NOT rebalance (waits for user to top up custody)
4. User sees warning in UI: "⚠️ Low custody balance — rebalance paused"
5. User tops up → hub rebalances on next cycle
```

## UX integration

### account panel

```
┌─────────────────────────────────────┐
│  USDC Account with H1               │
│                                      │
│  Bilateral:  $1,200.00              │
│  Collateral: $500.00    🟢 secured  │
│  Custody:    $48.00     [Top Up]    │
│                                      │
│  ⚡ Autopilot: ON ($500 limit)      │
│  Last rebalance: 2min ago (-$2.00)  │
└─────────────────────────────────────┘
```

### onboarding default

During account opening:
1. If autopilot mode → suggest $20 initial custody deposit
2. Show: "This covers ~10 rebalance operations"
3. User can skip (custody = $0, rebalance paused until funded)

### custody history (in account frame history)

```
Frame #45  hub_custody_debit  -$2.00  "rebalance_fee:R2C:$800"
Frame #43  hub_custody_debit  -$0.10  "routing_fee:htlc:0xab12..."  
Frame #40  deposit_to_custody +$50.00
Frame #38  hub_custody_debit  -$2.00  "rebalance_fee:R2C:$600"
```

## fee model

### rebalance fee

```
fee = gasCost + hubMargin

gasCost = estimatedGas × gasPrice (from RPC)
hubMargin = max(baseFee, amount × liquidityFeeBPS / 10000)

V1 defaults:
  baseFee = $1 USDC
  liquidityFeeBPS = 10 (0.1%)
  estimatedGas ≈ 200K gas
  
Example: R→C $1000
  gasCost ≈ $0.50 (anvil testnet)
  hubMargin = max($1, $1000 × 0.001) = $1
  total fee = $1.50
```

### routing fee

```
fee = baseFee + amount × routingFeePPM / 1_000_000

V1 defaults:
  baseFee = $0.01
  routingFeePPM = 100 (0.01%)

Example: route $100 payment
  fee = $0.01 + $100 × 0.0001 = $0.02
```

## implementation plan

### phase 1: data structure
- Add `custody: Map<number, bigint>` to AccountMachine
- Add to proof body (disputable)
- Add to frame state hash

### phase 2: accountTx handlers
- `deposit_to_custody` handler
- `withdraw_from_custody` handler  
- `hub_custody_debit` handler (hub-only auth check)

### phase 3: hub integration
- hubRebalanceHandler checks custody before R→C
- Deducts fee via hub_custody_debit in same frame
- broadcastBatch proceeds only if fee collected

### phase 4: UI
- Custody balance in AccountPanel
- "Top Up" / "Withdraw" buttons
- Custody history in frame list
- Low-balance warning

### phase 5: auto-topup (V2)
- Configure min/target custody levels
- Auto-refill from bilateral balance when low

## files

```
runtime/account-tx/handlers/custody-deposit.ts
runtime/account-tx/handlers/custody-withdraw.ts
runtime/account-tx/handlers/custody-debit.ts
runtime/types.ts                    (add custody to AccountMachine)
runtime/entity-crontab.ts           (check custody before R→C)
frontend/src/lib/components/Entity/CustodyPanel.svelte
docs/custody.md                     (this file)
```

## security

- Hub can ONLY debit custody, never bilateral balance unilaterally
- Custody debit requires valid reason (logged, auditable)
- Custody is included in dispute proof — hub can't lie about balance
- User can withdraw all custody anytime (no lockup)
- If hub debits more than custody balance → frame rejected (consensus fail)
- Maximum single debit capped at custody balance (no overdraft)

## comparison with alternatives

| approach | online required? | hub can act alone? | auditable? |
|----------|-----------------|-------------------|------------|
| bilateral fee (directPayment) | YES | NO | YES |
| custody balance | NO | YES (debit only) | YES |
| allowance (ERC20-style) | NO | YES (up to limit) | YES |
| trust-based (hub just takes) | NO | YES | NO |

Custody is the sweet spot: hub autonomy + user auditability.