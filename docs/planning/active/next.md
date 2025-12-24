# next.md - Priority Tasks

## ✅ COMPLETED (2024-12)

- **HTLC Support** - htlc_lock, htlc_reveal, htlc_timeout handlers
- **Lock-Based Capacity** - leftHtlcHold/rightHtlcHold in deriveDelta
- **lock-ahb.ts scenario** - Multi-hop HTLC routing with fees
- **Merge tiny helpers** - entity-helpers→utils, gossip-loader→gossip
- **Orderbook engine** - runtime/orderbook/ (from archive, refactored)

## 🔥 IN PROGRESS: Swaps

### Swap Implementation (Next Session)
- [ ] **Add SwapOffer type to types.ts** - swapOffers Map, leftSwapHold/rightSwapHold
- [ ] **Implement swap-offer.ts** - User creates limit order, locks capacity
- [ ] **Implement swap-resolve.ts** - Hub fills 0-100% + optional cancel
- [ ] **Implement swap-cancel.ts** - User requests cancellation
- [ ] **swap-bilateral.ts scenario** - Alice↔Hub partial fills
- [ ] **swap-orderbook.ts scenario** - Alice↔Hub↔Bob matching

See: `docs/planning/active/swap-implementation-plan.md`

### HTLC Hardening (Before Production)
- [ ] **Hash encoding fix** - Use getBytes() not toUtf8Bytes() for Solidity compat
- [ ] **lockId collision fix** - Include senderEntityId + random nonce
- [ ] **Timelock bounds check** - Prevent underflow on long routes
- [ ] **htlc-timeout.ts scenario** - Non-cooperative path

See: `docs/planning/active/htlc-hardening.md`

## 🎯 P1 FEATURES

### Onion Routing - Payment Privacy (1-2 hours)
- Encrypt hop data so intermediaries can't see source/destination
- Each hop only sees: amount + nextHop (not source/dest)
- Files: `routing/onion.ts`, `account-tx/handlers/direct-payment.ts`

### Smart Rebalancing Algorithm (2-3 hours)
- Optimize net-sender/receiver matching to minimize on-chain ops
- ONE batch with N withdrawals + M deposits
- Files: `routing/rebalancer.ts`, `entity-crontab.ts`

### Dispute Timeouts & Auto-Reveal (1-2 hours)
- Crontab detects missing ACKs / expiring HTLCs
- Triggers disputes / reveals secrets
- Files: `entity-crontab.ts`, `account-tx/handlers/htlc-timeout.ts`

## 🚧 FUTURE

### Cross-J Swaps (HashLadder)
- Taker-generated ladder for partial fill signaling
- uint16 encoded as 2x8-bit hash chains
- See: `docs/planning/active/swap-implementation-plan.md` Phase 3

### Scenarios
- [ ] **flash-crash.ts** - Market maker insolvency + FIFO enforcement
- [ ] **correspondent-banking.ts** - Multi-hop FX routing
- [ ] **uniswap-amm.ts** - AMM via delta transformers

### Architecture Debt
- Entity positions must be RELATIVE to j-machine
- Graph3DPanel is 6000+ lines (split it)
- Time-travel memory optimization
