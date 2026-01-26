# next.md - Priority Tasks

## 🎯 MANDATE: UI-First Development

**Every feature MUST have:**
1. User story ("As a user, I want to...")
2. UX flow (screens, interactions)
3. Testable in browser before merge

**Goal:** Testnet + MVP release ASAP. No backend-only work without UI.

---

## 🔥 CURRENT PRIORITY: Production Safety + UI

### 1. Wallet Creation Flow (User Story)
> "As a user, I want to create a wallet and see my entities without switching modes"

- [x] Unified `/app` route (no separate `/vault`)
- [x] RJEA dropdown bar (Runtime → Jurisdiction → Entity → Account)
- [ ] Wallet creation wizard in BrainVaultView
- [ ] Entity registration wizard after wallet
- [ ] Success state: user sees their entity in dropdown

### 2. HTLC Payment Flow (User Story)
> "As a user, I want to send a payment through the network and see it complete"

- [ ] Payment button in EntityPanel → opens PaymentPanel
- [ ] Amount input + recipient selector
- [ ] Progress indicator (pending → routing → complete)
- [ ] Transaction history with status

**Backend (required for UI):**
- [ ] Hash encoding fix - `getBytes()` not `toUtf8Bytes()`
- [ ] lockId collision fix - senderEntityId + nonce
- [ ] Timelock bounds check

### 3. Dispute/Recovery Flow (User Story)
> "As a user, I want to see warnings when something goes wrong and recover funds"

- [ ] Warning badge on EntityPanel when HTLC expiring
- [ ] "Reveal Secret" button before timeout
- [ ] "Dispute" button for stale states
- [ ] Recovery status panel

**Backend (required for UI):**
- [ ] Crontab detects missing ACKs
- [ ] Auto-reveal logic
- [ ] Auto-dispute logic

### 4. Swap/Trading Flow (User Story)
> "As a user, I want to swap tokens and see my orders"

- [x] OrderbookPanel (exists)
- [x] UserOrdersPanel (exists)
- [ ] "Place Order" button in EntityPanel
- [ ] Order confirmation modal
- [ ] Fill notifications

---

## 🚧 BACKLOG (Post-MVP)

| Feature | User Story | Status |
|---------|-----------|--------|
| Onion routing | "I want private payments" | Design needed |
| Smart rebalancing | "I want auto-optimized channels" | Design needed |
| Cross-J swaps | "I want to swap across networks" | HashLadder spec |
| Graph3D refactor | "I want smooth visualization" | 6000 lines tech debt |

---

## ✅ Definition of Done (for any PR)

1. Has user story in PR description
2. Works in browser at `/app`
3. No console errors
4. Mobile-responsive (test 375px width)
5. `bun run check` passes
