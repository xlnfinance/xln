// XLN Context Generator - Creates ultra-compact LLM-friendly context
// Output: frontend/static/llms.txt (accessible at xln.finance/llms.txt)
const fs = require('fs');
const path = require('path');

// ⭐ CORE FILES ONLY - Everything an LLM needs to understand XLN
// 🔴 READ ORDER: Solidity contracts FIRST (source of truth), then TypeScript runtime
const CORE_FILES = {
  contracts: [
    // ⚡ READ THESE FIRST - On-chain source of truth for all invariants
    'Types.sol',           // Shared types: Diff, BatchArgs, InsuranceReg
    'Depository.sol',      // Reserve/collateral management, enforceDebts FIFO, RCPAN invariant
    'EntityProvider.sol',  // Hanko verification, governance, C/D shares
    'Account.sol',         // A-machine on-chain: bilateral account state, settlements
    'DeltaTransformer.sol', // Delta transformations: HTLCs, swaps, limit orders
  ],
  runtime: [
    // Core data structures and implementation
    'types.ts',              // All TypeScript interfaces
    'ids.ts',                // Identity system: EntityId, SignerId, JId, ReplicaKey

    // Main coordinators (how the system works)
    'runtime.ts',            // Main coordinator, 100ms ticks, R→E→A routing
    'entity-consensus.ts',   // BFT consensus (ADD_TX → PROPOSE → SIGN → COMMIT)
    'account-consensus.ts',  // Bilateral account consensus between entities
    'j-batch.ts',            // J-batch system: E-machine accumulates → jBroadcast → J-machine

    // Transaction processing (how txs are applied)
    'entity-tx/index.ts',    // Entity transaction types
    'entity-tx/apply.ts',    // Entity transaction dispatcher
    'entity-tx/validation.ts', // Transaction validation
    'entity-tx/financial.ts', // Financial accounting (addToReserves, etc)
    'entity-tx/proposals.ts', // Proposal logic
    'entity-tx/j-events.ts',  // Jurisdiction event handling

    'account-tx/index.ts',   // Account transaction types
    'account-tx/apply.ts',   // Account transaction dispatcher

    // Routing (multi-hop payments)
    'routing/graph.ts',      // Network graph representation
    'routing/pathfinding.ts', // Dijkstra routing algorithm

    // Utilities (support functions)
    'state-helpers.ts',      // Pure state management functions
    'snapshot-coder.ts',     // Deterministic state serialization
    'evm.ts',                // Blockchain integration layer
  ],
  docs: [
    // Ordered by dependency - read in this order
    'emc2.md',               // ⚡ Core philosophy: E=mc² → Energy-Mass-Credit (5min)
    'docs/12_invariant.md',  // ⚡ RCPAN vs FCUAN vs FRPAP (THE core innovation) (10min)
    'docs/JEA.md',           // ⚡ Jurisdiction-Entity-Account 3-layer model (8min)
    'docs/11_Jurisdiction_Machine.md', // Architecture deep-dive
    'PriorArt.md',           // Why Lightning/rollups don't work
  ],
  worlds: [
    'architecture.md'        // Scenario architecture, EntityInput primitives
  ]
};

function countLines(content) {
  return content.split('\n').length;
}

function generateSemanticOverview(contractsDir, runtimeDir, docsDir, worldsDir, totalTokens) {
  // Count lines for each file
  const fileSizes = {};

  CORE_FILES.contracts.forEach(file => {
    const content = readFileContent(contractsDir, file);
    if (content) fileSizes[`contracts/${file}`] = countLines(content);
  });

  CORE_FILES.runtime.forEach(file => {
    const content = readFileContent(runtimeDir, file);
    if (content) fileSizes[`runtime/${file}`] = countLines(content);
  });

  CORE_FILES.docs.forEach(file => {
    const content = readFileContent(docsDir, file);
    if (content) fileSizes[`vibepaper/${file}`] = countLines(content);
  });

  CORE_FILES.worlds.forEach(file => {
    const content = readFileContent(worldsDir, file);
    if (content) fileSizes[`worlds/${file}`] = countLines(content);
  });

  return `# XLN Context - Core System Files (~${Math.round(totalTokens / 1000)}k tokens)

## THE CORE INNOVATION: RCPAN Invariant

XLN solves what was thought impossible: **instant settlement without blockchain latency**.

The breakthrough is the RCPAN invariant that unifies credit and collateral:
  −Lₗ ≤ Δ ≤ C + Lᵣ

Where:
- Δ = net balance (positive = you owe me, negative = I owe you)
- C = my collateral (what I can lose)
- Lₗ = credit I extend to you (unsecured lending)
- Lᵣ = credit you extend to me (your trust in me)

This single invariant:
- Eliminates the FCUAN problem (Full Credit Unprovable Account Networks)
- Eliminates the FRPAP problem (Full Reserve Provable Account Primitives)
- Enables instant bilateral netting with partial collateral
- Makes credit programmable and composable

## Competitive Landscape

| System | Settlement | Collateral | Credit | Netting | Trust Model |
|--------|-----------|------------|---------|---------|-------------|
| **XLN** | Instant (bilateral) | Partial (RCPAN) | Programmable | Yes (bilateral) | BFT consensus |
| Lightning | Near-instant | Full (100%) | No | No | Unilateral exit |
| Rollups | 7-day finality | Full (100%) | No | No (batch only) | Fraud proof |
| Banks | T+2 settlement | Fractional (~10%) | Yes | Yes (multilateral) | Legal system |
| Ripple/Stellar | 3-5 sec | Trust lines | Trust lines | Limited | Consensus |

**XLN uniquely combines**: Bank-like netting + Lightning-like instant settlement + Programmable credit

## Impossible Before XLN

1. **Instant cross-chain atomic swaps with <100% collateral** - Lightning requires full collateral, XLN uses RCPAN
2. **Bilateral settlement without fraud period** - Rollups need 7 days, XLN settles instantly via consensus
3. **Programmable credit as a first-class primitive** - Banks have credit but not programmable, crypto has programs but not credit
4. **Multi-hop payments that NET positions** - Ripple batches, Lightning routes, only XLN nets bilaterally
5. **Entity-owned subcontracts (HTLCs, limit orders) without separate channels** - One bilateral account, many subcontracts

## Token Budget Guide (~${Math.round(totalTokens / 1000)}k tokens total)

**Critical path (read first, ~30min):**
- ⚡ emc2.md (5min) - Why credit = stored energy
- ⚡ docs/12_invariant.md (10min) - RCPAN derivation
- ⚡ docs/jea.md (8min) - 3-layer architecture
- ⚡ Depository.sol (7min) - enforceDebts() FIFO + RCPAN enforcement

**Implementation (read second, ~45min):**
- types.ts (10min) - All data structures
- entity-consensus.ts (15min) - BFT state machine
- account-consensus.ts (12min) - Bilateral consensus
- entity-tx/apply.ts (8min) - Transaction dispatcher

**Deep dives (optional, ~60min):**
- runtime.ts (15min) - Main coordinator
- routing/pathfinding.ts (10min) - Dijkstra multi-hop
- priorart.md (20min) - Why Lightning/rollups fail
- 11_Jurisdiction_Machine.md (15min) - Full architecture

## Building on XLN: Delta Transformers

Every bilateral account is a **programmable state machine** that transforms deltas. Examples:

**1. HTLC (Hash Time-Locked Contract):**
\`\`\`typescript
// Alice → Bob payment locked by hash H
Δ_proposed = +1000  // Bob's balance increases IF he reveals R where hash(R) = H
// If Bob reveals R: commit Δ_proposed
// If timeout: revert Δ_proposed
\`\`\`

**2. Limit Order:**
\`\`\`typescript
// "Buy 100 USDC at 0.5 ETH each when ETH/USDC ≤ 2000"
if (oraclePrice <= 2000) {
  Δ_USDC = +100
  Δ_ETH = -50
}
\`\`\`

**3. Dividend Distribution:**
\`\`\`typescript
// Entity pays 10% dividend to all C-share holders
for (const holder of cShareHolders) {
  Δ[holder] = entity.reserves * 0.1 * (holder.cShares / totalCShares)
}
\`\`\`

**4. Netting Optimizer:**
\`\`\`typescript
// Instead of A→B→C→D, net to A→D
multiHopDeltas = [{A: -100}, {B: +100, C: -100}, {D: +100}]
nettedDelta = {A: -100, D: +100}  // B and C netting canceled
\`\`\`

Every subcontract is just a **delta transformer** that respects RCPAN invariant.

## Proof & Verification

**How to verify XLN's core claims:**

1. **RCPAN invariant eliminates FCUAN/FRPAP**: Read docs/12_invariant.md lines 45-120 (proof by construction)
2. **Instant bilateral settlement**: See account-consensus.ts ADD_TX → PROPOSE → SIGN → COMMIT (no fraud period)
3. **BFT consensus correctness**: entity-consensus.ts implements PBFT-style 3-phase commit (⅔ threshold)
4. **On-chain enforcement**: Depository.sol enforceDebts() FIFO queue processes debts until reserves depleted
5. **Deterministic state**: snapshot-coder.ts RLP encoding + Keccak-256 hashing ensures identical state roots

**Run scenarios yourself:**
\`\`\`bash
bun run src/server.ts  # Starts server
# Visit localhost:8080
# Load scenario: "phantom-grid" or "diamond-dybvig"
# Inspect entity states in console: inspect("alice")
\`\`\`

## Cross-Local Network: Off-chain settlement with on-chain anchoring

🔴 **READ SOLIDITY FIRST** - Contracts are the source of truth for all invariants

xln/
  jurisdictions/contracts/
    Types.sol                  ${fileSizes['contracts/Types.sol'] || '?'} lines - Shared types: Diff, BatchArgs, InsuranceReg
    Depository.sol             ${fileSizes['contracts/Depository.sol'] || '?'} lines - enforceDebts() FIFO, collateral + credit (INVARIANT: L+R+C=0)
    EntityProvider.sol         ${fileSizes['contracts/EntityProvider.sol'] || '?'} lines - Hanko sigs, Control/Dividend, governance
    Account.sol                ${fileSizes['contracts/Account.sol'] || '?'} lines - A-machine on-chain: bilateral accounts, settlements
    DeltaTransformer.sol       ${fileSizes['contracts/DeltaTransformer.sol'] || '?'} lines - Delta transformations: HTLCs, swaps, limit orders

  runtime/
    types.ts                     ${fileSizes['runtime/types.ts'] || '?'} lines - All TypeScript interfaces (START HERE)
    ids.ts                       ${fileSizes['runtime/ids.ts'] || '?'} lines - Identity system: EntityId, SignerId, JId, ReplicaKey
    runtime.ts                   ${fileSizes['runtime/runtime.ts'] || '?'} lines - Main coordinator, 100ms ticks, R->E->A routing
    entity-consensus.ts          ${fileSizes['runtime/entity-consensus.ts'] || '?'} lines - BFT consensus (ADD_TX -> PROPOSE -> SIGN -> COMMIT)
    account-consensus.ts         ${fileSizes['runtime/account-consensus.ts'] || '?'} lines - Bilateral consensus, left/right perspective
    j-batch.ts                   ${fileSizes['runtime/j-batch.ts'] || '?'} lines - J-batch: E-machine accumulates → jBroadcast → J-machine

    entity-tx/
      index.ts                   ${fileSizes['runtime/entity-tx/index.ts'] || '?'} lines - Entity transaction types
      apply.ts                   ${fileSizes['runtime/entity-tx/apply.ts'] || '?'} lines - Entity tx dispatcher
      validation.ts              ${fileSizes['runtime/entity-tx/validation.ts'] || '?'} lines - Transaction validation
      financial.ts               ${fileSizes['runtime/entity-tx/financial.ts'] || '?'} lines - Financial accounting
      proposals.ts               ${fileSizes['runtime/entity-tx/proposals.ts'] || '?'} lines - Proposal logic
      j-events.ts                ${fileSizes['runtime/entity-tx/j-events.ts'] || '?'} lines - Jurisdiction events

    account-tx/
      index.ts                   ${fileSizes['runtime/account-tx/index.ts'] || '?'} lines - Account transaction types
      apply.ts                   ${fileSizes['runtime/account-tx/apply.ts'] || '?'} lines - Account tx dispatcher

    routing/
      graph.ts                   ${fileSizes['runtime/routing/graph.ts'] || '?'} lines - Network graph
      pathfinding.ts             ${fileSizes['runtime/routing/pathfinding.ts'] || '?'} lines - Dijkstra routing

    state-helpers.ts             ${fileSizes['runtime/state-helpers.ts'] || '?'} lines - Pure state management
    snapshot-coder.ts            ${fileSizes['runtime/snapshot-coder.ts'] || '?'} lines - Deterministic RLP serialization
    evm.ts                       ${fileSizes['runtime/evm.ts'] || '?'} lines - Blockchain integration

  vibepaper/
    emc2.md                      ${fileSizes['vibepaper/emc2.md'] || '?'} lines - ⚡ Energy-Mass-Credit equivalence (CRITICAL PATH)
    docs/12_invariant.md         ${fileSizes['vibepaper/docs/12_invariant.md'] || '?'} lines - ⚡ RCPAN innovation (CRITICAL PATH)
    docs/JEA.md                  ${fileSizes['vibepaper/docs/JEA.md'] || '?'} lines - ⚡ Jurisdiction-Entity-Account model (CRITICAL PATH)
    docs/11_Jurisdiction_Machine.md  ${fileSizes['vibepaper/docs/11_Jurisdiction_Machine.md'] || '?'} lines - Architecture deep-dive
    PriorArt.md                  ${fileSizes['vibepaper/PriorArt.md'] || '?'} lines - Why Lightning/rollups don't work

  worlds/
    architecture.md              ${fileSizes['worlds/architecture.md'] || '?'} lines - Scenario architecture, EntityInput primitives

Reading Guide:
1. Start with header sections (RCPAN invariant, competitive landscape, impossibilities)
2. Follow the token budget guide for efficient learning:
   - Critical path (30min): emc2.md → 12_invariant.md → jea.md → Depository.sol
   - Implementation (45min): types.ts → entity-consensus.ts → account-consensus.ts → entity-tx/apply.ts
   - Deep dives (60min): runtime.ts → routing/pathfinding.ts → priorart.md → 11_Jurisdiction_Machine.md
3. Verify claims using the Proof & Verification section
4. Explore delta transformer examples for extensibility patterns

Suggested LLM prompt: "Read the critical path docs (30min budget), then explain how RCPAN enables instant settlement with partial collateral. Compare to Lightning and rollups."

`;
}

function readFileContent(baseDir, relativePath) {
  const fullPath = path.join(baseDir, relativePath);
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    return content;
  } catch (error) {
    console.warn(`⚠️  Could not read ${relativePath}: ${error.message}`);
    return null;
  }
}

function generateContext() {
  const projectRoot = path.resolve(__dirname, '../../');
  const contractsDir = path.join(projectRoot, 'jurisdictions/contracts');
  const runtimeDir = path.join(projectRoot, 'runtime');
  const docsDir = path.join(projectRoot, 'vibepaper');
  const worldsDir = path.join(projectRoot, 'worlds');

  // Track file sizes for token breakdown
  const fileStats = [];

  // Collect all files first to calculate total tokens
  const allFiles = [];

  CORE_FILES.contracts.forEach(file => {
    const content = readFileContent(contractsDir, file);
    if (content) {
      const lines = countLines(content);
      const bytes = Buffer.byteLength(content, 'utf8');
      fileStats.push({ file: `contracts/${file}`, lines, bytes });
      allFiles.push({ path: `jurisdictions/contracts/${file}`, content, lines });
    }
  });

  CORE_FILES.runtime.forEach(file => {
    const content = readFileContent(runtimeDir, file);
    if (content) {
      const lines = countLines(content);
      const bytes = Buffer.byteLength(content, 'utf8');
      fileStats.push({ file: `runtime/${file}`, lines, bytes });
      allFiles.push({ path: `runtime/${file}`, content, lines });
    }
  });

  CORE_FILES.docs.forEach(file => {
    const content = readFileContent(docsDir, file);
    if (content) {
      const lines = countLines(content);
      const bytes = Buffer.byteLength(content, 'utf8');
      fileStats.push({ file: `vibepaper/${file}`, lines, bytes });
      allFiles.push({ path: `vibepaper/${file}`, content, lines });
    }
  });

  CORE_FILES.worlds.forEach(file => {
    const content = readFileContent(worldsDir, file);
    if (content) {
      const lines = countLines(content);
      const bytes = Buffer.byteLength(content, 'utf8');
      fileStats.push({ file: `worlds/${file}`, lines, bytes });
      allFiles.push({ path: `worlds/${file}`, content, lines });
    }
  });

  // Calculate total bytes for all content
  const totalBytes = fileStats.reduce((sum, f) => sum + f.bytes, 0);
  const totalTokens = Math.round(totalBytes / 3.5);

  // Generate overview with token count
  let output = generateSemanticOverview(contractsDir, runtimeDir, docsDir, worldsDir, totalTokens);

  // Append all file contents
  allFiles.forEach(({ path, content, lines }) => {
    output += `\n//${path} (${lines} lines)\n`;
    output += content + '\n';
  });

  return { output, fileStats };
}

// Generate and write
const { output: context, fileStats } = generateContext();
const outputPath = path.join(__dirname, '../../frontend/static/llms.txt');

// Ensure directory exists
const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(outputPath, context);

// Stats
const lines = context.split('\n').length;
const bytes = Buffer.byteLength(context, 'utf8');
const kb = (bytes / 1024).toFixed(1);
const tokensTotal = Math.round(bytes / 3.5);

console.log('✅ llms.txt generated');
console.log(`📊 ${lines.toLocaleString()} lines, ${kb} KB, ~${tokensTotal.toLocaleString()} tokens`);
console.log(`🌐 xln.finance/llms.txt`);
console.log(`📁 Contracts: ${CORE_FILES.contracts.length} | Runtime: ${CORE_FILES.runtime.length} | Docs: ${CORE_FILES.docs.length} | Worlds: ${CORE_FILES.worlds.length}`);

// Token breakdown by file (top 15)
console.log('\n📈 Token Breakdown (top 15):');
const fileTokens = fileStats.map(f => ({
  ...f,
  tokens: Math.round(f.bytes / 3.5),
  pct: (f.bytes / bytes * 100).toFixed(1)
})).sort((a, b) => b.tokens - a.tokens);

fileTokens.slice(0, 15).forEach(f => {
  const tokStr = f.tokens.toLocaleString().padStart(7);
  const pctStr = f.pct.padStart(4);
  console.log(`  ${tokStr} tok (${pctStr}%) - ${f.file}`);
});
