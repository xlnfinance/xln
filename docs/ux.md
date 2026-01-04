# xln UX Architecture - Hierarchical Navigation

**Last updated:** 2026-01-04
**Status:** Design phase (implementation pending)

---

## Vision

**Problem:** xln looks like developer tools, has 0 traction. Users think "layer 2 = rollups" when xln is better.

**Solution:** Consumer-first UX with hidden developer power tools.

---

## Two-Mode Architecture

### User Mode (Default - Consumer Focus)
- Simple, clean interface
- Hide technical complexity
- Focus on: Send, Receive, Swap
- No frame stepping, no consensus states

### Dev Mode (Toggle 👁️ - Developer Tools)
- Full network graph (Graph3DPanel)
- All panels (Architect, Jurisdiction, Runtime I/O, Settings)
- Time machine (frame stepping)
- Multi-entity inspection
- ASCII/JSON dumps

**Toggle:** Bottom-right button (purple, minimalist)
**Shares runtime:** Both modes use same `localEnvStore` (no state duplication)

---

## Hierarchical Navigation Model

### Five-Level Hierarchy

```
Runtime (Level 1 - Global)
└─ Jurisdiction (Level 2 - Blockchain/Network)
   └─ Signer (Level 3 - Identity/Keys)
      └─ Entity (Level 4 - xln Account)
         └─ Account (Level 5 - Bilateral Relationship)
```

### Navigation Bar (Top)

```
┌────────────────────────────────────────────────────────────────────┐
│ Runtime ▼ | Jurisdiction: BrowserVM ▼ | Signer: Alice ▼ |         │
│ Entity: 0x001 ▼ | Account: ↔Hub ▼                          Dev ◢  │
└────────────────────────────────────────────────────────────────────┘
```

**Each dropdown:**
- Shows current selection
- Lists all items at this level (filtered by parent)
- **+ New** button to create new item
- Click to switch active selection

**Breadcrumb behavior:**
- Click any level → navigate to that level's page
- Child levels auto-filter by parent

---

## Level 1: Runtime (Global Overview)

### Purpose
Top-level view of ALL financial activity across all jurisdictions.

### What It Shows
```
┌─────────────────────────────────────────────────────────────┐
│  🌐 Runtime Overview                                         │
├─────────────────────────────────────────────────────────────┤
│  💰 Total Value Locked: $12.5M                               │
│     ├─ BrowserVM: $2.5M (2 entities, 5 accounts)            │
│     ├─ Ethereum: $10M (8 entities, 23 accounts)             │
│     └─ Arbitrum: $0 (0 entities)                            │
│                                                              │
│  📊 Activity (Last 24h):                                     │
│     • 1,234 transactions                                     │
│     • $2.3M volume                                           │
│     • 45 HTLCs routed                                        │
│                                                              │
│  🏛️ Jurisdictions (3):                                       │
│  ┌──────────────┬────────────┬──────────┬─────────┐        │
│  │ Name         │ Entities   │ Volume   │ Status  │        │
│  ├──────────────┼────────────┼──────────┼─────────┤        │
│  │ BrowserVM    │ 2          │ $2.5M    │ ✓ Live  │        │
│  │ Ethereum     │ 8          │ $10M     │ ✓ Live  │        │
│  │ Arbitrum     │ 0          │ $0       │ Inactive│        │
│  └──────────────┴────────────┴──────────┴─────────┘        │
│                                                              │
│  [+ New Jurisdiction] [Import Runtime] [Export State]       │
└─────────────────────────────────────────────────────────────┘
```

### Data Sources
- `env.jReplicas` - All jurisdictions
- `env.eReplicas` - All entities (aggregate)
- `env.history` - Global transaction history

### Actions
- **+ New Jurisdiction:** Deploy new Depository contract
- **Import Runtime:** Load JSON state
- **Export State:** Download full runtime

---

## Level 2: Jurisdiction (Blockchain/Network)

### Purpose
Manage a specific blockchain/network (BrowserVM, Ethereum, etc.)

### What It Shows
```
┌─────────────────────────────────────────────────────────────┐
│  🏛️ Jurisdiction: BrowserVM                                  │
├─────────────────────────────────────────────────────────────┤
│  📍 Depository: 0xe7f1725e... (deployed)                     │
│  📊 Block: 156 | Mempool: 3 txs                              │
│  💰 Total Locked: $2.5M (across 2 entities)                  │
│                                                              │
│  👤 Signers in this Jurisdiction (2):                        │
│  ┌──────────┬─────────────────┬──────────┬────────┐        │
│  │ Name     │ Address         │ Entities │ Volume │        │
│  ├──────────┼─────────────────┼──────────┼────────┤        │
│  │ Alice    │ 0xABC...        │ 1        │ $1.2M  │ ←      │
│  │ Bob      │ 0xDEF...        │ 1        │ $1.3M  │        │
│  └──────────┴─────────────────┴──────────┴────────┘        │
│                                                              │
│  🪙 Tokens:                                                  │
│     • USDC (ID: 1) - $2.5M                                   │
│     • ETH (ID: 2) - 45 ETH                                   │
│                                                              │
│  [+ New Signer] [View Contracts] [Block Explorer]           │
└─────────────────────────────────────────────────────────────┘
```

### Data Sources
- `env.jReplicas.get(jurisdictionName)` - J-Machine state
- Filter `env.eReplicas` by jurisdiction
- `browserVM` or other EVM instance

### Actions
- **+ New Signer:** Opens BrainVault modal → auto-creates entity
- **View Contracts:** Show Depository, EntityProvider bytecode
- **Block Explorer:** J-block history

---

## Level 3: Signer (Identity/Keys)

### Purpose
Manage cryptographic identity (keys, addresses, entities)

### What It Shows
```
┌─────────────────────────────────────────────────────────────┐
│  👤 Signer: Alice                                            │
├─────────────────────────────────────────────────────────────┤
│  🔑 Address: 0xABC123...DEF (Copy 📋)                        │
│  💎 Source: BrainVault "alice@first.xln.finance"            │
│     └─ Signer index: 0 (m/44'/60'/0'/0/0)                   │
│                                                              │
│  💰 ERC20 Balances (EntityProvider):                         │
│     • USDC: 2,500 (deposited)                                │
│     • ETH: 10 ETH                                            │
│                                                              │
│  🏢 Entities Controlled (1):                                 │
│  ┌──────────┬──────────┬──────────┬──────────┐             │
│  │ Entity   │ Reserves │ Accounts │ Status   │             │
│  ├──────────┼──────────┼──────────┼──────────┤             │
│  │ 0x001    │ $1.2M    │ 3        │ ✓ Active │ ←           │
│  └──────────┴──────────┴──────────┴──────────┘             │
│                                                              │
│  [+ New Entity] [Deposit to EntityProvider] [Export Key]    │
│                                                              │
│  🔐 BrainVault Settings:                                     │
│  • Factor: 5 (64GB memory-hard)                              │
│  • Derivation: argon2id-sharded/v2.0                         │
│  • Mnemonic: ••••••••••• (24 words) [Reveal]                │
│  • Derive more signers: [+ Signer 1] [+ Signer 2]          │
└─────────────────────────────────────────────────────────────┘
```

### Data Sources
- `activeVault` (from vaultStore)
- `activeSigner` (from vaultStore)
- Filter `env.eReplicas` by signer address
- EVM balance queries (via EntityProvider)

### Actions
- **+ New Entity:** Auto-create in current jurisdiction
- **Deposit:** Move ERC20/ETH into EntityProvider (→ reserves)
- **Derive Signer:** BrainVault derive next index
- **Rename:** Update signer display name

### Auto-Creation Flow
```
User clicks "+ New Entity"
  ↓
Auto-create entity with:
  • EntityId: keccak256(signerAddress + timestamp)
  • SignerId: signer address
  • Jurisdiction: current jurisdiction
  • Auto-register with EntityProvider
  ↓
Navigate to Entity page
  ↓
Show empty entity (no reserves, no accounts)
  ↓
Prompt: "Fund your entity? [Deposit from ${signerAddress}]"
```

---

## Level 4: Entity (Financial Operations)

### Purpose
Manage xln entity (reserves, accounts, payments)

**This is current EntityPanel** - keep as-is, just integrate into nav hierarchy.

### What It Shows
- Reserves (token balances in entity)
- Accounts (bilateral relationships)
- HTLC locks (multi-hop payments in progress)
- Swap orders (active offers)
- Consensus state
- Payment/settlement controls
- Chat, proposals, history

### Actions
- **+ New Account:** Open bilateral with selected counterparty
- **Send:** Direct payment or HTLC routing
- **Receive:** Show QR code / address
- **Swap:** Create maker order

### Auto-Account Flow
```
User clicks "+ New Account"
  ↓
Modal: "Open account with:"
  • Search: [bob@second.xln.finance]
  • Or select from hubs: [first.xln.finance] [hub.somecex.com]
  ↓
Auto-create bilateral account:
  • Propose frame 0 (add_delta)
  • Set credit limits
  • Deposit collateral (optional)
  ↓
Account appears in accounts list
  ↓
Ready to send/receive with this counterparty
```

---

## Level 5: Account (Bilateral Relationship)

### Purpose
Detailed view of bilateral account with specific counterparty

**This is current AccountPanel** - keep as-is.

### What It Shows
- Per-token deltas (offdelta, ondelta, collateral)
- Credit limits (capacity in/out)
- HTLC holds (locked capacity)
- Swap holds (order collateral)
- Transaction history (frame-by-frame)
- Settlement controls

### Actions
- **Adjust Credit:** Propose new credit limits
- **Deposit Collateral:** R2C transfer
- **Withdraw:** C2R settlement
- **Close Account:** Final settlement

---

## Implementation Plan

### Phase 1: Navigation Bar (2-3h)

**Create:** `frontend/src/lib/components/Navigation/HierarchicalNav.svelte`

```svelte
<script>
  export let currentLevel: 'runtime' | 'jurisdiction' | 'signer' | 'entity' | 'account';
  export let selections = {
    runtime: null,
    jurisdiction: null,
    signer: null,
    entity: null,
    account: null
  };

  // Dropdown data
  $: runtimes = getRuntimes();
  $: jurisdictions = getJurisdictions(selections.runtime);
  $: signers = getSigners(selections.jurisdiction);
  $: entities = getEntities(selections.signer);
  $: accounts = getAccounts(selections.entity);
</script>

<nav class="hierarchical-nav">
  <Dropdown
    label="Runtime"
    items={runtimes}
    selected={selections.runtime}
    on:select={e => navigate('runtime', e.detail)}
    on:new={() => createRuntime()}
  />

  {#if selections.runtime}
    <Dropdown
      label="Jurisdiction"
      items={jurisdictions}
      selected={selections.jurisdiction}
      on:select={e => navigate('jurisdiction', e.detail)}
      on:new={() => createJurisdiction()}
    />
  {/if}

  <!-- ... repeat for signer, entity, account -->
</nav>
```

**Tasks:**
1. Create Dropdown.svelte component (reusable)
2. Add data fetching functions (getRuntimes, getSigners, etc.)
3. Wire navigation (click → update selection → load page)
4. Add "+ New" handlers

### Phase 2: Level Views (3-4h)

**2.1 RuntimeView (NEW - 1h)**
- Aggregate stats across jurisdictions
- Jurisdiction list (clickable)
- Total value locked, activity graphs
- Import/export runtime

**2.2 JurisdictionView (Enhance existing - 30min)**
- Merge current DepositoryPanel + parts of ArchitectPanel
- Show signers in this jurisdiction
- Contract info, block explorer

**2.3 SignerView (NEW - 1h)**
- Wrap BrainVaultView in signer context
- Show ERC20/ETH balances
- List entities controlled by signer
- BrainVault settings (factor, mnemonic reveal)

**2.4 EntityView (Refactor EntityPanel - 1h)**
- Keep all current functionality
- Add "within signer" context
- Remove redundant info (now in parent levels)

**2.5 AccountView (Keep AccountPanel - 0min)**
- No changes needed
- Already perfect for bilateral detail

### Phase 3: Auto-Creation Logic (1-2h)

**3.1 Signer → Entity (Auto)**
```typescript
// In JurisdictionView or SignerView
async function onSignerAdded(signer: Signer) {
  // Auto-create entity for new signer
  const entityId = generateEntityId(signer.address);

  await applyRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importReplica',
      entityId,
      signerId: signer.address,
      data: {
        isProposer: true,
        config: { /* ... */ },
        jurisdiction: currentJurisdiction
      }
    }]
  });

  // Link entity to signer
  vaultOperations.setSignerEntity(signer.index, entityId);

  // Navigate to new entity
  navigate('entity', entityId);

  // Prompt to fund entity
  showFundingPrompt(entityId, signer.address);
}
```

**3.2 Entity → Account (Manual with wizard)**
```typescript
// In EntityView
async function onNewAccount() {
  // Show modal: "Open account with:"
  const counterparty = await selectCounterparty();
  // Options: Search, select from hubs, paste entityId

  // Create bilateral account
  await applyRuntimeInput(env, {
    entityInputs: [{
      entityId: currentEntity,
      signerId: currentSigner,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: counterparty }
      }]
    }]
  });

  // Navigate to new account
  navigate('account', counterparty);
}
```

### Phase 4: URI Integration (Future)

**Signer = URI:**
- `alice@first.xln.finance:8443`
- `https://bob.personal.com:8080`
- Gossip layer maps URI → entityId → publicKey

**Hub Registry:**
- Curated list: `first.xln.finance`, `hub.somecex.com`
- User can add custom hubs
- Auto-discovery via gossip

**Contact Resolution:**
```typescript
resolveContact("bob@second.somecex.com")
  → Query gossip
  → Get {entityId, publicKey, online: true}
  → Open account or HTLC route
```

---

## User Flow Examples

### Example 1: First-Time User (Consumer)

```
1. User goes to xln.finance/app
   → Lands in User Mode

2. Sees BrainVault (no wallet yet)
   ┌───────────────────────────────┐
   │ Create your xln wallet        │
   │ [Name] [Passphrase] [Factor]  │
   │ [Create Wallet]                │
   └───────────────────────────────┘

3. User creates wallet (factor 3, 16 shards, 1 minute)
   ┌───────────────────────────────┐
   │ Creating wallet...             │
   │ ████████░░ 80% (13/16 shards) │
   └───────────────────────────────┘

4. Wallet created → Auto-creates entity
   ┌───────────────────────────────┐
   │ ✓ Wallet created!              │
   │ Setting up your account...     │
   └───────────────────────────────┘

5. Shows EntityPanel (user mode)
   ┌───────────────────────────────┐
   │ 💰 Your Wallet                 │
   │ Balance: $0                    │
   │                                │
   │ [Deposit] [Receive]            │
   │                                │
   │ No accounts yet.               │
   │ [+ Connect to Hub]             │
   └───────────────────────────────┘

6. User clicks "+ Connect to Hub"
   → Opens account with first.xln.finance
   → Can now send/receive

7. User clicks "Dev" button (curious)
   → Sees full network graph
   → Clicks "User" → back to simple view
```

### Example 2: Power User (Multi-Entity)

```
1. User in Dev Mode

2. Nav bar shows:
   Runtime | Jurisdiction: BrowserVM | Signer: Alice | Entity: 0x001 | Account: ↔Hub

3. User clicks "Signer: Alice ▼"
   Dropdown shows:
   • Alice (Signer 0) ✓
   • Bob (Signer 1)
   • Charlie (Signer 2)
   • + New Signer

4. User clicks "+ New Signer"
   → BrainVault modal opens (same mnemonic, derive index 3)
   → Creates Signer 3
   → Auto-creates Entity for Signer 3
   → Nav updates: "Signer: Signer 3 | Entity: 0x004"

5. User sees empty entity for Signer 3
   → [+ New Account] → select Hub
   → Account created
   → Ready to operate as Signer 3

6. User switches back: "Signer: Alice ▼" → click Alice
   → Nav shows Alice's entities
   → Seamless switch between identities
```

### Example 3: Developer (Testing Multi-Party)

```
1. Developer in Dev Mode

2. Creates 3 signers:
   • Alice (Signer 0)
   • Hub (Signer 1)
   • Bob (Signer 2)

3. For each signer, entity auto-created:
   • Alice → Entity 0x001
   • Hub → Entity 0x002
   • Bob → Entity 0x003

4. Opens accounts:
   • Alice ↔ Hub
   • Hub ↔ Bob

5. Nav bar:
   Signer: Alice ▼ | Entity: 0x001 | Account: ↔Hub

6. Alice sends HTLC to Bob:
   • Finds route: Alice → Hub → Bob
   • Creates encrypted envelope
   • Sends payment

7. Developer switches signer to Hub:
   Signer: Hub ▼ | Entity: 0x002

8. Sees Hub's perspective:
   • Incoming lock from Alice
   • Forwarding to Bob
   • Fee earned

9. Switches to Bob:
   Signer: Bob ▼ | Entity: 0x003

10. Sees Bob's perspective:
    • Incoming lock from Hub
    • Auto-reveals secret
    • Payment received

All in ONE browser, ONE app, seamless switching!
```

---

## Technical Architecture

### Navigation State (Reactive)

```typescript
// frontend/src/lib/stores/navigationStore.ts (NEW)
export interface NavSelection {
  runtime: string | null;      // Runtime ID (for multi-runtime future)
  jurisdiction: string | null; // Jurisdiction name
  signer: string | null;       // Signer address
  entity: string | null;       // Entity ID
  account: string | null;      // Counterparty entity ID
}

export const navSelection = writable<NavSelection>({
  runtime: 'local',            // Default: local runtime
  jurisdiction: null,
  signer: null,
  entity: null,
  account: null
});

export function navigate(level: keyof NavSelection, value: string) {
  navSelection.update(s => {
    // Clear child levels when parent changes
    if (level === 'runtime') return { runtime: value, jurisdiction: null, signer: null, entity: null, account: null };
    if (level === 'jurisdiction') return { ...s, jurisdiction: value, signer: null, entity: null, account: null };
    if (level === 'signer') return { ...s, signer: value, entity: null, account: null };
    if (level === 'entity') return { ...s, entity: value, account: null };
    return { ...s, account: value };
  });
}
```

### Page Routing

```typescript
// In View.svelte, determine which page to show based on navigation
$: currentPage = (() => {
  if (!navSelection.jurisdiction) return 'runtime';
  if (!navSelection.signer) return 'jurisdiction';
  if (!navSelection.entity) return 'signer';
  if (!navSelection.account) return 'entity';
  return 'account';
})();

{#if currentPage === 'runtime'}
  <RuntimeView />
{:else if currentPage === 'jurisdiction'}
  <JurisdictionView jurisdiction={navSelection.jurisdiction} />
{:else if currentPage === 'signer'}
  <SignerView signer={navSelection.signer} />
{:else if currentPage === 'entity'}
  <EntityPanel entityId={navSelection.entity} signerId={navSelection.signer} />
{:else if currentPage === 'account'}
  <AccountPanel entity={navSelection.entity} account={navSelection.account} />
{/if}
```

### User Mode Simplification

**User mode hides upper levels:**
```
User Mode nav bar:
  [Your Wallet ▼] | [Contacts ▼]

Dev Mode nav bar:
  [Runtime ▼] | [Jurisdiction ▼] | [Signer ▼] | [Entity ▼] | [Account ▼]
```

In user mode:
- Auto-select: current signer's first entity
- "Your Wallet" dropdown = entity selector
- "Contacts" dropdown = account selector
- No runtime/jurisdiction exposed

---

## BrainVault Integration

### Current BrainVault (5453 LOC)

**Responsibilities:**
- Wallet creation (argon2id derivation)
- Signer management (HD derivation)
- Vault switching (multiple identities)
- Progress tracking, resume tokens
- i18n, sound effects, animations

### Proposed Integration

**Don't merge** - BrainVault is too complex to embed.

**Instead: Progressive Enhancement**

**Level 1: Signer selection**
- If no vault: Show BrainVault creation flow (current UI)
- If vault exists: Show signer selector + entity list

**Level 2: Entity operations**
- Show EntityPanel for selected signer's entity
- BrainVault settings accessible via dropdown

**Separation:**
```
SignerView.svelte (NEW - 200 LOC)
├─ If no wallet: <BrainVaultView /> (full UI)
├─ If wallet: Signer selector + entity list
└─ Settings: [Manage BrainVault] → modal with BrainVaultView
```

**BrainVaultView stays as-is** - too valuable to refactor (5K LOC, works perfectly)

---

## Files to Create

### New Components (4 files, ~800 LOC total)

1. **`HierarchicalNav.svelte`** (~200 LOC)
   - 5-level dropdown navigation
   - Breadcrumb behavior
   - "+ New" buttons

2. **`RuntimeView.svelte`** (~150 LOC)
   - Aggregate stats
   - Jurisdiction list
   - Import/export

3. **`JurisdictionView.svelte`** (~200 LOC)
   - Merge Depository + Architect jurisdiction parts
   - Signer list
   - Contract info

4. **`SignerView.svelte`** (~250 LOC)
   - Wrap BrainVaultView (if no wallet)
   - Signer info + entity list (if wallet exists)
   - ERC20 balances from EntityProvider

### Modified Components (2 files)

5. **`View.svelte`** (~50 LOC changes)
   - Add HierarchicalNav to top
   - Page routing based on navSelection
   - Remove old panel creation logic

6. **`EntityPanel.svelte`** (~20 LOC changes)
   - Accept signer context as prop
   - Add "+ New Account" button

### New Stores (1 file)

7. **`navigationStore.ts`** (~80 LOC)
   - NavSelection interface
   - navigate() function
   - Persist selection to localStorage

---

## User Mode vs Dev Mode

### User Mode Simplified Nav

```
┌────────────────────────────────────┐
│ [Your Wallet ▼] | [Contacts ▼]     │
│                           Dev ◢    │
└────────────────────────────────────┘

Your Wallet dropdown:
  • Alice's Wallet (0x001)
  • Bob's Wallet (0x003)
  • + New Wallet

Contacts dropdown:
  • Hub (first.xln.finance)
  • Charlie (charlie@hub.com)
  • + Add Contact
```

**Behind the scenes:**
- Your Wallet = entity selector
- Contacts = account selector
- Hides runtime/jurisdiction/signer complexity

### Dev Mode Full Nav

```
┌──────────────────────────────────────────────────────────────┐
│ Runtime: Local ▼ | Jurisdiction: BrowserVM ▼ |               │
│ Signer: Alice ▼ | Entity: 0x001 ▼ | Account: ↔Hub ▼   User ◢│
└──────────────────────────────────────────────────────────────┘
```

Shows full hierarchy for debugging/development.

---

## Migration Path

### Session 1 (Next): Build Foundation (3-4h)
- ✅ Create navigationStore.ts
- ✅ Create HierarchicalNav.svelte
- ✅ Create Dropdown.svelte (reusable)
- ✅ Wire basic navigation (select → load page)

### Session 2: Build Views (3-4h)
- ✅ RuntimeView
- ✅ JurisdictionView
- ✅ SignerView (wrap BrainVault)
- ✅ Update View.svelte routing

### Session 3: Auto-Creation + Polish (2-3h)
- ✅ Auto-create entity when signer added
- ✅ "+ New Account" wizard
- ✅ User mode simplified nav
- ✅ Test full flow (create wallet → entity → account → send)

### Session 4: URI Integration (2-3h)
- ✅ Contact resolver (bob@hub.com)
- ✅ Hub registry
- ✅ Gossip URI mapping
- ✅ Multi-runtime connections

**Total:** ~12-15 hours to full consumer-ready UX

---

## Open Questions

1. **Runtime ID format:**
   - Single local runtime: `'local'`
   - Multi-runtime: URI-based? (`'https://alice.com:8080'`)

2. **Entity ID generation:**
   - Deterministic: `keccak256(signerAddress + jurisdiction + index)`
   - Random: `crypto.randomBytes(32)`

3. **Default signer naming:**
   - Auto-name: "Signer 1", "Signer 2"
   - Prompt: "Enter name for this signer"

4. **Hub discovery:**
   - Hardcoded: `['first.xln.finance', 'hub.somecex.com']`
   - Gossip-based: Query network for available hubs
   - Manual: User adds hub URIs

5. **Multi-runtime scope:**
   - Phase 2: Single local runtime
   - Phase 3: Connect to remote runtimes (network)
   - Phase 4: Multi-runtime orchestrator (testing clusters)

---

## Success Metrics

**Consumer PMF:**
- User can create wallet in <2 minutes
- User can send money in <30 seconds
- User doesn't see "entity", "replica", "frame" words
- User understands "Connect to Hub" = "Link bank account"

**Developer Power:**
- Dev mode reveals full state machine
- Can inspect any entity/account
- Frame stepping works
- Multi-party testing in one browser

**Both satisfied** → mass adoption + technical credibility

---

## Next Steps

**Immediate (This Session):**
- [x] Design hierarchical nav (this document)
- [ ] Get user approval on approach
- [ ] Clarify open questions

**Next Session:**
- [ ] Implement navigationStore.ts
- [ ] Build HierarchicalNav.svelte
- [ ] Create RuntimeView.svelte
- [ ] Test navigation flow

**Future:**
- [ ] Auto-creation wizards
- [ ] URI integration
- [ ] Multi-runtime support
- [ ] Consumer UX polish
