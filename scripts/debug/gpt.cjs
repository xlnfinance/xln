// XLN Context Generator - Creates ultra-compact LLM-friendly context
// Output: frontend/static/c.txt (accessible at xln.finance/c.txt)
const fs = require('fs');
const path = require('path');

// ⭐ CORE FILES ONLY - Everything an LLM needs to understand XLN
const CORE_FILES = {
  contracts: [
    // Future ERC interfaces (to be standardized)
    'IDepository.sol',       // ERC interface for reserve-credit management
    'IEntityProvider.sol',   // ERC interface for entity governance & Hanko verification
    'ISubcontractProvider.sol', // ERC interface for bilateral logic execution

    // Reference implementations
    'Depository.sol',        // Full Depository with enforceDebts, collateral, credit
    'DepositoryV1.sol',      // Simplified Depository for simnet/testnet
    'EntityProvider.sol',    // Full EntityProvider with Hanko, governance, C/D shares
    'EntityProviderV1.sol',  // Simplified EntityProvider for simnet/testnet
    'SubcontractProvider.sol', // Delta transformers: HTLCs, swaps, limit orders
    'SubcontractProviderV1.sol', // Simplified SubcontractProvider for simnet/testnet

    // Primitives and utilities
    'ECDSA.sol',             // Signature recovery (cryptographic primitives)
    'Token.sol',             // Test ERC20 token
    'console.sol',           // Hardhat console logging

    // Test mocks
    'ERC20Mock.sol',
    'ERC721Mock.sol',
    'ERC1155Mock.sol'
  ],
  runtime: [
    'runtime.ts',            // Main coordinator, 100ms ticks, R→E→A routing
    'entity-consensus.ts',   // BFT consensus (ADD_TX → PROPOSE → SIGN → COMMIT)
    'evm.ts',                // Blockchain integration layer
    'account-consensus.ts',  // Bilateral account consensus between entities
    'types.ts',              // All TypeScript interfaces
    'state-helpers.ts',      // Pure state management functions
    'snapshot-coder.ts'      // Deterministic state serialization
  ],
  docs: [
    'xlnview.md',            // System overview
    'emc2.md',               // Core philosophy: E=mc² → Energy-Mass-Credit
    'priorart.md',           // Why Lightning/rollups don't work
    'docs/summary.md',       // Executive summary
    'docs/00_QA.md',         // FAQs: value prop, positioning, architecture
    'docs/12_invariant.md',  // RCPE vs FCUAN vs FRPAP (THE core innovation)
    'docs/jea.md',           // Jurisdiction-Entity-Account 3-layer model
    'docs/consensus/transaction-flow-specification.md', // Transaction flows
    'docs/11_Jurisdiction_Machine.md' // Architecture deep-dive
  ]
};

function generateSemanticOverview() {
  return `# XLN Context - Core System Files
## Cross-Local Network: Off-chain settlement with on-chain anchoring

This context contains the essential files to understand XLN's architecture and innovations.

### 🔐 Smart Contracts (jurisdictions/)

**Proposed ERC Interfaces** (Future standards via EIP submissions):
- **IDepository.sol** (115 lines) ⭐ ERC-XXXX for Reserve-Credit Management
  Bilateral reserve/collateral interface. INVARIANT: leftDiff + rightDiff + collateralDiff == 0
  Functions: _reserves(), settle(), prefundAccount(), getCollateral()

- **IEntityProvider.sol** (107 lines) ⭐ ERC-YYYY for Entity Governance & Verification
  Ephemeral entities, Hanko signatures, hierarchical governance
  Functions: registerEntity(), verifyHankoSignature(), recoverEntity(), proposeNewBoard()

- **ISubcontractProvider.sol** (74 lines) ⭐ ERC-ZZZZ for Bilateral Logic Execution
  Delta transformers for composable bilateral DeFi
  Functions: applyBatch(), encodeBatch(), revealSecret(), hashToBlock()

**Reference Implementations (V1 = Simnet-Ready):**
- **Depository.sol** (1652 lines) - Full implementation with dispute resolution (disabled for now)
  enforceDebts() FIFO queue, collateral splitting, credit extension, debt tracking.
  First in history: Escrowed collateral + credit beyond + mechanical repayment enforcement.

- **DepositoryV1.sol** (277 lines) - Minimal implementation for simnet/testnet
  Implements IDepository. Core reserve/collateral only, no dispute logic.

- **EntityProvider.sol** (1118 lines) - Full implementation with C/D shares, governance
  Hanko signatures (ephemeral entities, packed: N×64 + ceil(N/8) bytes).
  Control/Dividend token separation, board proposals, name registry.

- **EntityProviderV1.sol** (1118 lines) - Same as EntityProvider.sol (simnet-ready)
  Implements IEntityProvider. V1 naming convention for simnet deployment.

- **SubcontractProvider.sol** (154 lines) - HTLCs + Swaps implementation
  applyBatch(), revealSecret(). First generalized bilateral DeFi (vs Lightning's hardcoded HTLCs).

- **SubcontractProviderV1.sol** (154 lines) - Same as SubcontractProvider.sol (simnet-ready)
  Implements ISubcontractProvider. V1 naming convention for simnet deployment.

**Utilities:**
- **ECDSA.sol** (98 lines) - Signature recovery primitives
- **Token.sol** (41 lines) - Test ERC20 token
- **console.sol** (45 lines) - Hardhat logging
- **ERC20/721/1155Mock.sol** - Test mocks

### ⚡ Runtime Layer (runtime/)

- **runtime.ts** (1093 lines)
  Main coordinator. Routes inputs every 100ms tick: Runtime → Entity → Account.
  Manages global state, LevelDB persistence, scenario execution.

- **entity-consensus.ts** (953 lines)
  BFT consensus state machine. Flow: ADD_TX → PROPOSE → SIGN → COMMIT.
  Pure functional: (prevState, input) → {nextState, outbox}

- **evm.ts** (920 lines)
  Blockchain integration. Connects to Depository/EntityProvider contracts.
  Handles BrowserVM (simnet) + testnet/mainnet jurisdictions.

- **account-consensus.ts** (674 lines)
  Bilateral consensus between entity pairs. Left/right perspective handling.
  Deterministic state verification via snapshot-coder.

- **types.ts** (565 lines)
  All TypeScript interfaces. Single source of truth for data structures.
  Includes: Entity, Account, Transaction, Frame, Settlement types.

- **state-helpers.ts** (313 lines)
  Pure state management utilities. Immutable operations on consensus state.

- **snapshot-coder.ts** (239 lines)
  Deterministic state serialization. RLP encoding for consensus verification.

### 📚 Documentation (vibepaper/)

- **xlnview.md** - System overview, panel architecture, BrowserVM integration
- **emc2.md** - Core philosophy: Energy-Mass-Credit equivalence
- **priorart.md** ⭐ WHY LIGHTNING/ROLLUPS DON'T WORK
  "All broadcast O(n) designs fundamentally bottlenecked"
  "Rollups = perpetuum mobile" (data availability paradox)

- **docs/00_QA.md** ⭐ VALUE PROP FAQs
  Why not rollups? Why credit? Why hubs? Positioning vs TradFi/crypto.

- **docs/12_invariant.md** ⭐ THE CORE INNOVATION
  RCPE (Reserve-Credit Provable Enforceable) vs
  FCUAN (Full-Credit Unprovable As-is Now - TradFi) vs
  FRPAP (Full-Reserve Provable - Lightning)
  XLN = collateral + credit + proofs + mechanical enforcement

- **docs/jea.md** - Jurisdiction-Entity-Account 3-layer model
  "Accounts are atoms, Entities are molecules, Jurisdiction is atmosphere"

- **docs/summary.md** - Executive summary for quick orientation
- **docs/consensus/transaction-flow-specification.md** - Transaction flows
- **docs/11_Jurisdiction_Machine.md** - Architecture patterns

---

## Reading Guide for LLMs

**Understand the innovation first:**
1. **docs/12_invariant.md** - THE core primitive (RCPE)
2. **IDepository.sol** - Clean interface (future ERC)
3. **Depository.sol:1012-1068** - enforceDebts() mechanism
4. **docs/00_QA.md** - Why this matters (vs Lightning/rollups)

**Then understand the architecture:**
5. **types.ts** - Data structures
6. **entity-consensus.ts** - BFT consensus
7. **account-consensus.ts** - Bilateral state machines
8. **runtime.ts** - How it all connects

**For deeper dives:**
9. **EntityProvider.sol:528-680** - Hanko signatures (ephemeral entities)
10. **SubcontractProvider.sol:58-110** - Delta transformers (bilateral DeFi)

---

## First in History Innovations

1. **Reserve-Credit Invariant**: Collateral + credit extension + mechanical enforcement (enforceDebts FIFO)
2. **Hanko Signatures**: Ephemeral hierarchical entities without pre-registration
3. **Account Proofs**: Cryptographic proof of balance (unilateral exit with signed state)
4. **Subcontracts**: Programmable delta transformers (generalized bilateral DeFi)
5. **BrainVault**: argon2id KDF with tunable work factor (secure memorizable keys)

## Proposed ERC Standards (via EIP process)

XLN will submit 3 interfaces as Ethereum standards to enable bilateral finance ecosystem:

1. **IDepository** (ERC-XXXX) - Reserve-Credit Management
   - Bilateral reserve tracking, collateral management, settlement with invariant enforcement
   - Enables: CEX proof of reserves, payment channel prefunding, credit extension

2. **IEntityProvider** (ERC-YYYY) - Entity Governance & Verification
   - Hanko signature verification, entity registration, quorum checking
   - Enables: Ephemeral multi-sig, hierarchical governance, zero-gas entity creation

3. **ISubcontractProvider** (ERC-ZZZZ) - Bilateral Logic Execution
   - Delta transformer interface for programmable bilateral state transitions
   - Enables: HTLCs, swaps, limit orders, any custom bilateral DeFi logic

Together these form the "Bilateral Finance Stack" - composable primitives for off-chain settlement with on-chain anchoring.

---

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
  let output = generateSemanticOverview();

  output += '\n\n' + '='.repeat(80) + '\n';
  output += '## FILE CONTENTS\n';
  output += '='.repeat(80) + '\n\n';

  // Process contracts
  const contractsDir = path.join(projectRoot, 'jurisdictions/contracts');
  CORE_FILES.contracts.forEach(file => {
    const content = readFileContent(contractsDir, file);
    if (content) {
      output += `\n--- jurisdictions/contracts/${file} ---\n`;
      output += content + '\n';
    }
  });

  // Process runtime files
  const runtimeDir = path.join(projectRoot, 'runtime');
  CORE_FILES.runtime.forEach(file => {
    const content = readFileContent(runtimeDir, file);
    if (content) {
      output += `\n--- runtime/${file} ---\n`;
      output += content + '\n';
    }
  });

  // Process documentation
  const docsDir = path.join(projectRoot, 'vibepaper');
  CORE_FILES.docs.forEach(file => {
    const content = readFileContent(docsDir, file);
    if (content) {
      output += `\n--- vibepaper/${file} ---\n`;
      output += content + '\n';
    }
  });

  // Meta: Include this script itself at the very end
  output += '\n\n' + '='.repeat(80) + '\n';
  output += '## META: HOW THIS CONTEXT WAS GENERATED\n';
  output += '='.repeat(80) + '\n\n';
  output += 'The context file you are reading was generated by gpt.cjs.\n';
  output += 'This script selects core files from the XLN repository and combines them\n';
  output += 'into a single LLM-friendly context file with semantic annotations.\n\n';

  const scriptPath = path.join(projectRoot, 'scripts/debug/gpt.cjs');
  const scriptContent = readFileContent(projectRoot, 'scripts/debug/gpt.cjs');
  if (scriptContent) {
    output += `\n--- scripts/debug/gpt.cjs ---\n`;
    output += scriptContent + '\n';
  }

  return output;
}

// Generate and write
const context = generateContext();
const outputPath = path.join(__dirname, '../../frontend/static/c.txt');

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
const words = context.split(/\s+/).length;

// Token estimates (different methods for accuracy range)
const tokensConservative = Math.round(words * 0.75);  // Text-heavy estimate
const tokensRealistic = Math.round(bytes / 3.5);      // Mixed code+docs (GPT-4 rule)
const tokensCodeHeavy = Math.round(bytes / 3.0);      // Code-heavy upper bound

console.log('✅ XLN context generated successfully!');
console.log(`📄 Output: ${outputPath}`);
console.log(`📊 Stats: ${lines.toLocaleString()} lines, ${kb} KB, ${words.toLocaleString()} words`);
console.log(`🤖 Tokens (approx): ${tokensRealistic.toLocaleString()} (~${tokensConservative.toLocaleString()}-${tokensCodeHeavy.toLocaleString()} range)`);
console.log(`🌐 URL: xln.finance/c.txt`);
console.log('');
console.log('Core files included:');
console.log(`  🔐 Contracts: ${CORE_FILES.contracts.length} (ALL .sol files)`);
console.log(`  ⚡ Runtime: ${CORE_FILES.runtime.length}`);
console.log(`  📚 Docs: ${CORE_FILES.docs.length} (includes 12_invariant - core innovation)`);
console.log(`  🔧 Meta: 1 (gpt.cjs itself)`);
console.log('');
console.log('Proposed ERC Standards (Bilateral Finance Stack):');
console.log('  1. IDepository (ERC-XXXX) - Reserve-Credit Management');
console.log('  2. IEntityProvider (ERC-YYYY) - Entity Governance & Verification');
console.log('  3. ISubcontractProvider (ERC-ZZZZ) - Bilateral Logic Execution');
console.log('');
console.log('Innovations documented:');
console.log('  1. Reserve-Credit Invariant (enforceDebts + collateral)');
console.log('  2. Hanko Signatures (ephemeral entities)');
console.log('  3. Account Proofs (cryptographic balance verification)');
console.log('  4. Subcontracts (programmable delta transformers)');
console.log('  5. BrainVault (secure memorizable keys)');
