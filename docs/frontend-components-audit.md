# Frontend Component Audit (MVP Testnet)

**Date:** 2026-02-02
**Goal:** Identify relevant components for user wallet vs legacy dev tools

---

## ✅ **KEEP - Core Wallet (MVP)**

### User Flow Components
- **RuntimeCreation.svelte** - Login (alice/bob auto-login) ✅
- **UserModePanel.svelte** - Main wallet container ✅
- **WalletView.svelte** - Portfolio display + action buttons ✅

### Entity Management
- **EntityPanelTabs.svelte** - External/Reserves/Accounts tabs ✅
- **EntityDropdown.svelte** - Entity selector ✅
- **AccountDropdown.svelte** - Account selector ✅
- **AccountPanel.svelte** - Account details ✅
- **FormationPanel.svelte** - Create entity (if needed) ✅

### Wallet Features
- **TokenList.svelte** - Show ERC20 balances ✅
- **ERC20Send.svelte** - Send external tokens ✅
- **DepositToEntity.svelte** - Deposit to reserves ✅
- **PaymentPanel.svelte** - Offchain payments ✅

### Infrastructure
- **JurisdictionPanel.svelte** - Show testnet status ✅
- **RuntimeDropdown.svelte** - Runtime selector (alice/bob) ✅
- **WalletSettings.svelte** - Settings ✅

---

## ⚠️ **MAYBE KEEP - Useful but not critical**

### Discovery
- **HubDiscoveryPanel.svelte** - Find hubs (useful for routing) 🤔
- **GossipPanel.svelte** - See network peers 🤔

### Advanced Features
- **SettlementPanel.svelte** - Manual settlements 🤔
- **SwapPanel.svelte** - Token swaps 🤔
- **TransactionHistory/** - Activity log 🤔

---

## ❌ **REMOVE - Legacy Dev/Architect Tools**

### Developer Mode (Scenarios)
- **ArchitectPanel.svelte** - God mode (scenarios, prepopulate) ❌
  - **Only keep for /scenarios route**
  - Remove from /app wallet mode

### Visualization (Not wallet)
- **Graph3DPanel.svelte** - 3D network viz ❌
  - **Only keep for /scenarios route**

### Developer Tools
- **RuntimeIOPanel.svelte** - Runtime inputs/outputs ❌
- **ConsolePanel.svelte** - Developer console ❌
- **SettingsPanel.svelte** - Advanced settings ❌
  - **(Keep WalletSettings.svelte instead)**

### Advanced Finance (Post-MVP)
- **InsurancePanel.svelte** - Insurance layer ❌
- **SolvencyPanel.svelte** - Risk analytics ❌
- **HtlcActivityPanel.svelte** - HTLC details ❌
  - **(Move to AccountPanel as subtab)**

---

## 🔄 **NEEDS REFACTOR**

### Current Issues

**Problem 1: Multiple env instances**
- VaultStore creates env
- View.svelte creates env
- ArchitectPanel creates env
- **Solution:** ONE env creation in RuntimeCreation.svelte

**Problem 2: WalletView vs UserModePanel**
- WalletView = simple portfolio (legacy)
- UserModePanel = full entity panel (new)
- Both show similar data
- **Solution:** Merge into EntityWalletPanel.svelte

**Problem 3: EntityPanelTabs**
- Shows External/Reserves/Accounts ✅
- But still references BrowserVM for balances
- **Solution:** Use testnet RPC for all balance queries

---

## 📋 **RECOMMENDED STRUCTURE (MVP)**

```
/app route (User Wallet):
├── RuntimeCreation.svelte (Login)
│   └── Auto-login as alice
│   └── Create SINGLE env with testnet
│   └── Pass env to UserModePanel
│
└── UserModePanel (Main View)
    ├── RuntimeDropdown (alice/bob selector)
    ├── EntityDropdown (entity selector)
    ├── AccountDropdown (account selector)
    │
    ├── EntityPanelTabs
    │   ├── External Tab
    │   │   ├── TokenList (ERC20 balances)
    │   │   └── [Faucet A Button] → API
    │   │
    │   ├── Reserves Tab
    │   │   ├── Reserve balances
    │   │   └── [Faucet B Button] → API
    │   │
    │   └── Accounts Tab
    │       ├── Account list
    │       ├── AccountPanel (selected account)
    │       └── [Faucet C Button] → API
    │
    └── WalletSettings (cog icon)

/scenarios route (Dev Mode):
└── ArchitectPanel
    └── Graph3DPanel
    └── All dev tools
```

---

## 🎯 **ACTION PLAN**

### Phase 1: Remove from /app route
```bash
# Delete panels from View.svelte user mode:
- Graph3DPanel (only scenarios)
- ArchitectPanel (only scenarios)
- RuntimeIOPanel (delete entirely)
- ConsolePanel (delete entirely)
```

### Phase 2: Fix env duplication
```bash
# RuntimeCreation.svelte becomes single source:
1. Create env with testnet
2. Pass to UserModePanel via props
3. Remove env creation from View.svelte
4. Remove env creation from VaultStore
```

### Phase 3: Add faucet buttons
```bash
# EntityPanelTabs.svelte:
- External tab: Add "Request Faucet" button → /api/faucet/erc20
- Reserves tab: Add "Fund Reserves" button → /api/faucet/reserve
- Accounts tab: Add "Request Payment" button → /api/faucet/offchain
```

---

## 🗑️ **FILES TO DELETE**

```
frontend/src/lib/components/:
- Admin/ (entire directory - not used)
- Embed/ (scenarios only)
- Home/ (landing page, not wallet)
- IO/ (runtime I/O, dev tool)
- Landing/ (marketing, not wallet)
- Network/ (3D viz helpers, scenarios only)
- Scenario/ (scenarios only)
- Tools/ (dev tools)
- Trading/ (orderbook, post-MVP)

frontend/src/lib/view/panels/:
- ConsolePanel.svelte (dev tool)
- RuntimeIOPanel.svelte (dev tool)
- InsurancePanel.svelte (post-MVP)
- SolvencyPanel.svelte (post-MVP)
```

**Estimated cleanup:** ~30 unused components, ~15k LOC reduction

---

## 📊 **COMPONENT COUNT**

**Total:** 81 Svelte files

**Keep (Wallet):** ~25 files
**Keep (Scenarios):** ~15 files
**Delete (Unused):** ~30 files
**Refactor:** ~11 files

---

**Next steps:**
1. Remove dev panels from /app route
2. Fix env duplication
3. Add 3 faucet buttons
4. Test E2E wallet flow
