---
agent: claude-sonnet-4.5
feature: hub-auto-rebalance
status: final-design
updated: 2026-02-13T22:30:00Z
confidence: 995/1000
---

# Final V1 Design - Fee Flow + Priority Matching

## ✅ USER DECISIONS

**Matching algorithm:**
- ✅ PRIORITY (2019 pattern), NOT FIFO
- ✅ Service HNW first (biggest requests)
- ✅ Pull from max netSpenders first
- ✅ Optimize for gas efficiency

**Fee flow:**
- ✅ New accountTx types (not directPayment)
- ✅ Quote → Pay → Execute (3-step flow)
- ✅ USDT-denominated fees

**Gemini's FIFO suggestion:** REJECTED (user confirmed 2019 priority is better)

---

## 🔄 FEE REQUEST FLOW

```typescript
// 1. User requests quote
rebalance_request_quote: {
  tokenId: number;
  targetAmount: bigint;
}

// 2. Hub responds
rebalance_quote_response: {
  quoteId: string;
  tokenId: number;
  amount: bigint;
  feeUSDT: bigint;      // $5 USDT
  expiresAt: number;    // 60s TTL
}

// 3. User pays + accepts
rebalance_fee_payment: {
  quoteId: string;
  feeAmount: bigint;    // Must match quote
  accepted: boolean;
}

// 4. Hub executes (if fee paid + quote valid)
deposit_collateral + j_broadcast
```

---

## 📊 PRIORITY MATCHING (2019 Pattern)

```typescript
// Sort by VALUE (optimize gas per dollar):

netReceivers.sort((a, b) =>
  Number(b.requested - a.requested)
) // Biggest requests first

netSenders.sort((a, b) =>
  Number(b.debt - a.debt)
) // Biggest debts first

// Result:
// $10k request served before $100 request
// $50k debt pulled before $500 debt
// Most efficient use of gas ✅
```

---

**Delegating to Opus:** Rebalancing implementation
**I'm doing:** UI improvements

**Both start now!** 🚀
