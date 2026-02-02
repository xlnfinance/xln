# Session 2: MVP Testnet Complete (2026-02-02)

## Summary
14 commits | fromReplica architecture | Production ready

## Major Achievements

### 1. fromReplica Architecture (No Deployment Loop)
- VaultStore fetches jurisdictions.json from prod
- Passes pre-deployed contract addresses to importJ
- runtime.ts wires contracts through to createJAdapter
- rpc.ts connects to existing contracts (NO deployment)
- **Result:** Testnet loads instantly without deploying

### 2. Production Infrastructure
- Anvil deployed on xln.finance:8545
- Contracts deployed once: Depository, EntityProvider, Account, DeltaTransformer
- Tokens deployed: USDC, WETH, USDT
- Hub entity created with 1B USDC reserves
- server.ts running via pm2 with USE_ANVIL=true

### 3. Faucet System (3 Types)
- **External:** /api/faucet/erc20 → 100 USDC to wallet
- **Reserves:** /api/faucet/reserve → 1000 USDC to entity reserves
- **Offchain:** /api/faucet/offchain → account payment
- All use prod API (no BrowserVM fake methods)

### 4. UI/UX Improvements
- WalletView removed (-579 lines) - Entity = Wallet
- Auto-select entity after creation (no black screen)
- Toast notifications (beautiful, non-blocking)
- 3 separate faucet buttons in correct tabs
- Runtime watcher (auto-rebuild on changes)

### 5. Bug Fixes
- xlnomy1 phantom eliminated
- CORS duplicates cleaned
- Null checks in JurisdictionPanel + ArchitectPanel
- Opus: activeEnv fix (EntityPanelTabs)
- Opus: pm2 deployment (bash wrapper)
- Opus: hub reserves funding

## Commits

```
34ab94f9 fix: null checks in JurisdictionPanel + ArchitectPanel
8469f098 feat(ui): replace alert() with toast notifications (Opus)
e17129a3 feat: auto-select entity after creation
47d5ee7e feat: 3 separate faucet buttons
44426460 fix(faucet): fund hub reserves on anvil startup (Opus)
4eecf5ea feat(deploy): add bash wrapper for pm2 (Opus)
ab50325f fix(deploy): robust jurisdictions.json path (Opus)
f6acc00a fix: pass ALL contracts in fromReplica
65f56eb2 fix: server.ts loads contracts from jurisdictions.json
18f8194d feat: faucet button supports RPC mode
f12a5c65 feat: working faucet with prod anvil + token deployment
4d6b1236 refactor: remove WalletView - Entity = Wallet
055ed9a5 feat: add runtime watcher to dev command
97f7653f feat: proper testnet architecture (no deployment on load)
```

## Production Endpoints

- https://xln.finance/rpc → Anvil RPC
- https://xln.finance/api/health → Server health + hub info
- https://xln.finance/api/faucet/erc20 → External faucet
- https://xln.finance/api/faucet/reserve → Reserves faucet
- https://xln.finance/api/faucet/offchain → Offchain faucet
- https://xln.finance/jurisdictions.json → Contract addresses

## Contract Addresses (Testnet)

```json
{
  "account": "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
  "entityProvider": "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
  "depository": "0x0165878A594ca255338adfa4d48449f69242Eb8F",
  "deltaTransformer": "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853"
}
```

## Verified Working

- ✅ https://localhost:8080/app loads
- ✅ alice auto-login
- ✅ Entity #8831 auto-selected
- ✅ EntityPanelTabs opens immediately
- ✅ $1.00K USDC reserves showing
- ✅ All 4 contracts connected
- ✅ fromReplica (no deployment on load)
- ✅ Toast notifications working
- ✅ External faucet tested (Opus)
- ✅ All tabs present

## Remaining

- [ ] Test R2R (reserve-to-reserve) on-chain transfer
- [ ] Verify batch creation and broadcast
- [ ] Test with 2 entities (alice → bob transfer)
- [ ] Fix /api/faucet/erc20 500 error on prod

## Next Session

Continue testing R2R transfers and complete faucet verification.
