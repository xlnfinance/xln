# NEXT.md - Priority Tasks

## 🔥 COMPLETED (2025-12-06): BrowserVM Multi-Contract Deployment + Runtime I/O Full Dump

### BrowserVM Contract Deployment ✅
- ✅ **Account.sol library** - Deploys first, address stored for linking
- ✅ **Depository.sol with linking** - Replaces `__$<hash>$__` placeholders with Account address
- ✅ **EntityProvider.sol** - Deploys for entity registration
- ✅ **Contract getters** - `getAccountAddress()`, `getDepositoryAddress()`, `getEntityProviderAddress()`, `getDeployedContracts()`

### JurisdictionPanel Updates ✅
- ✅ **Shows all 3 contracts** - ACC, DEP, EP badges with tooltips in header
- ✅ **Contract artifacts copied** - Account.json, Depository.json, EntityProvider.json in frontend/static/contracts/

### Runtime I/O Panel - Full Data Dump ✅
- ✅ **New "🔬 Full" view mode** - Complete frame data for time machine debugging
- ✅ **Expandable replica cards** - Entity state, reserves, accounts, debts, insurance
- ✅ **BigInt-safe formatting** - Proper handling of all numeric values

### Files Modified ✅
- `frontend/src/lib/view/utils/browserVMProvider.ts` - Multi-contract deployment with library linking
- `frontend/src/lib/view/panels/JurisdictionPanel.svelte` - All 3 contract addresses in header
- `frontend/src/lib/view/panels/RuntimeIOPanel.svelte` - Full dump view mode
- `frontend/static/contracts/` - Updated artifacts (Account.json, Depository.json, EntityProvider.json)

### Security Fixes (Depository.sol) ✅
- ✅ **Cooperative finalize zero-state** - Added `cooperativeNonce == 0` check (line 1027)
- ✅ **Nested nonReentrant fix** - Split `externalTokenToReserve` → `_externalTokenToReserve` internal
- ✅ **Contract size** - 23,247 bytes (1,329 bytes headroom under 24KB limit)

---

## 🔥 COMPLETED (2025-12-04): BrainVault Entity Auto-Creation

### Fixes ✅
- ✅ **Auto-save vault with input name** - No manual save modal, vault auto-saved on derivation complete
- ✅ **Invalid mnemonic checksum error** - Fixed Argon2id → BIP39 derivation flow
- ✅ **Auto-create entity for first signer** - `generateLazyEntityId()` creates proper lazy entity ID matching runtime algorithm, persisted via `vaultOperations.setSignerEntity(0, entityId)`

### Files Modified ✅
- `frontend/src/lib/components/Views/BrainVaultView.svelte`
  - Added `generateLazyEntityId()` helper (lines 617-634)
  - Entity ID uses canonical JSON + keccak256 (matches runtime)
  - Vault auto-saves with entity assignment on derivation complete

### Verified ✅
- `bun run check` passes (0 errors)
- Removed duplicate function definition from previous session

---

## 🔥 COMPLETED (2025-12-03): Identity System Refactor (Phase 1)

### New Files ✅
- ✅ **runtime/ids.ts** - Core identity system (~520 lines)
  - Branded types: `EntityId`, `SignerId`, `JId`, `EntityProviderAddress`
  - Structured `ReplicaKey` interface (no more string splitting)
  - URI format for future networking: `xln://{host}/{jId}/{epAddress}/{entityId}/{signerId}`
  - Type-safe collections: `ReplicaMap<T>`, `EntityMap<T>`
- ✅ **runtime/ids.test.ts** - 36 unit tests (all passing)
  - Type constructors, validators, ReplicaKey ops, display formatting
  - Entity type detection, URI operations, edge cases
  - Run: `bun test runtime/ids.test.ts`

### Updated Files ✅
- ✅ **runtime/runtime.ts** - Imports/exports all ids.ts functions
- ✅ **xlnStore.ts** - Migrated 2 split patterns, exposed via xlnFunctions:
  - `extractEntityId()`, `extractSignerId()`, `parseReplicaKey()`

### Verified ✅
- E2E test: 4/4 browser tests pass (Playwright)
- Unit tests: 36/36 pass

### Pending (Phase 2)
- ~26 split(':') patterns in frontend components (gradual migration as files touched)

---

## 🔥 COMPLETED (2025-11-30): Codex/Gemini Review Fixes + Multi-Agent Protocol

### Codex Blockers Fixed ✅
- ✅ **timeIndex default to -1** - View.svelte:129 now uses `?? -1` (LIVE mode default)
- ✅ **InsurancePanel time-travel aware** - Shows warning in history mode
- ✅ **Architect mutations blocked in history** - `requireLiveMode()` guard on all 10 mutation functions

### Gemini Security Fixes ✅
- ✅ **Mempool DoS protection** - entity-consensus.ts:111 checks `LIMITS.MEMPOOL_SIZE` (1000)
- ✅ **JurisdictionEvent typing** - types.ts has discriminated union (5 event types)
- ✅ **Rollback logic** - Confirmed correct (ackedTransitions=incoming, sentTransitions=outgoing)

### Sphere Rendering Fixes ✅
- ✅ **Sphere sizing** - Graph3DPanel.svelte:4596-4605 uses `dollarsPerPx = 1000`
- ✅ **Grey sphere bug** - Color now queries actual reserves via `checkEntityHasReserves()`

### Multi-Agent Protocol ✅
- ✅ **Created .agents/** - Full coordination protocol with economy system
- ✅ **Onboarding flow** - Agents read multiagent.md, create profile, write ready.md
- ✅ **Token budgets** - claude=500k/day, others=200k/day, subagent spawning
- ✅ **Papertrail** - All interactions logged to papertrail/{date}/

---

## 📁 FILES MODIFIED THIS SESSION:

```
runtime/
├─ entity-consensus.ts (mempool limit check)
├─ types.ts (JurisdictionEvent discriminated union)

frontend/src/lib/view/
├─ View.svelte (timeIndex default -1)
├─ panels/ArchitectPanel.svelte (requireLiveMode guards)
├─ panels/InsurancePanel.svelte (isHistoryMode + warning)
├─ panels/Graph3DPanel.svelte (dollarsPerPx, checkEntityHasReserves)

.agents/
├─ multiagent.md (full protocol v2)
├─ manifest.json
├─ economy/ledger.json
├─ profiles/claude-architect.md
├─ inbox/{claude,codex,gemini,glm}/
├─ outbox/{claude,codex,gemini,glm}/
├─ papertrail/2025-11-30/
├─ queue/, consensus/, subagents/, completed/
```

---

## 🚨 ARCHITECTURE DEBT (ASAP - 2025-12-03)

### A1. Entity positions must be RELATIVE to j-machine (CRITICAL)
**Problem:** Positions are stored as absolute x,y,z. Breaks when loading multiple jurisdictions.
**Solution:** Store `{jurisdictionId, relativeX, relativeY, relativeZ}` instead.
**Files:** xlnStore.ts, Graph3DPanel.svelte, runtime/types.ts

### A2. Replica key parsing is error-prone
**Problem:** `replicaKey.split(':')[0]` vs `[1]` causes bugs (just fixed one).
**Solution:** Add `parseReplicaKey(key): {entityId, signerId}` helper in runtime.
**Files:** runtime/utils.ts (new), xlnStore.ts, Graph3DPanel.svelte

### A3. xlnomies inconsistent type (Map vs Array)
**Problem:** `env.xlnomies` is Map in live mode, Array in history. Code has dual handling.
**Solution:** Always use Map. Serialize properly in history snapshots.
**Files:** runtime/types.ts, state-helpers.ts, Graph3DPanel.svelte:611-614

### A4. Time-travel is bolted on, not designed in
**Problem:** `history[]` stores full snapshots (memory hog). Panels mix live/historical reads.
**Solution:** Design proper time-travel-aware state access pattern.
**Files:** xlnStore.ts, all panels that read replicas

### A5. Graph3DPanel is 6000+ lines
**Problem:** Unmaintainable god-component.
**Solution:** Split: EntityRenderer, ConnectionRenderer, JMachineRenderer, CameraController
**Files:** Graph3DPanel.svelte → multiple files

### A6. Profiles vs Replicas vs Entities confusion
**Problem:** Three overlapping concepts. Which is source of truth?
- `gossipProfiles` - from gossip layer
- `replicas` - from consensus
- Entities in EntitiesPanel
**Solution:** Define clear ownership: Entity is canonical, replica is state, profile is metadata.
**Files:** Needs design doc first

### A7. Frontend reimplements runtime types
**Problem:** `xlnFunctions` wraps XLN instance methods with different error handling.
**Solution:** Single source of truth in runtime, frontend just consumes.
**Files:** xlnStore.ts:198-344

---

## 🎯 NEXT SESSION PRIORITIES:

### 1. Visual E2E Testing (HIGH)
- Run AHB demo end-to-end
- Verify sphere sizes look correct with new formula
- Confirm grey/green coloring matches reserves

### 2. Multi-Agent Onboarding (HIGH)
- Invite codex-reviewer, gemini-tester to .agents/
- Create first task in queue/
- Test consensus flow

### 3. SettingsPanel Slider (MEDIUM)
- Add `dollarsPerPx` slider to SettingsPanel
- Auto-adjust to prevent sphere overlap

### 4. File Splitting (LOW)
- ArchitectPanel.svelte is huge (~2300 lines)
- Consider splitting into sub-components

---

## 📋 LOW HANGS (can do quickly):

1. **Settings slider for dollarsPerPx** - ~20 lines in SettingsPanel.svelte
2. **Kill stale background shells** - Many zombie processes running
3. **Add .agents/ to .gitignore** - Prevent papertrail from bloating repo

---

## 🤖 MULTI-AGENT ONBOARDING PROMPT:

```
You are joining the XLN multi-agent development team.
READ THIS FIRST: /Users/zigota/xln/.agents/multiagent.md

After reading:
1. Create your profile in .agents/profiles/{your-codename}.md
2. Write "ready" to .agents/inbox/{your-codename}/ready.md
3. Check .agents/queue/ for unclaimed tasks
4. Follow papertrail protocol for ALL interactions

Your codename: codex-reviewer | gemini-tester | glm-auditor
```

---

## 📝 HUMAN COMMANDS (1 letter):

- `y` = approve & continue
- `n` = reject (explain why)
- `?` = show status
- `!` = emergency stop
- `1-9` = pick option
- ` ` = skip/next
