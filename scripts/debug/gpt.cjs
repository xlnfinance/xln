// XLN Context Generator - Creates ultra-compact LLM-friendly context
// Output: frontend/static/c.txt (accessible at xln.finance/c.txt)
const fs = require('fs');
const path = require('path');

// ⭐ CORE FILES ONLY - Everything an LLM needs to understand XLN
const CORE_FILES = {
  contracts: [
    'Depository.sol',        // Reserve/collateral management, batch processing
    'EntityProvider.sol',    // Entity registration, quorum verification
    'SubcontractProvider.sol' // Subcontract lifecycle management
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
    'emc2.md',               // Core philosophy
    'docs/summary.md',       // Executive summary
    'docs/consensus/transaction-flow-specification.md', // Transaction flows
    'docs/11_Jurisdiction_Machine.md' // Architecture deep-dive
  ]
};

function generateSemanticOverview() {
  return `# XLN Context - Core System Files
## Cross-Local Network: Off-chain settlement with on-chain anchoring

This context contains the essential files to understand XLN's architecture:

### 🔐 Smart Contracts (jurisdictions/)
- **Depository.sol** (1585 lines)
  Reserve and collateral management. Batch processing for on-chain settlements.
  Key functions: deposit(), withdraw(), processBatch(), verifyProof()

- **EntityProvider.sol** (1095 lines)
  Entity registration and quorum verification. Byzantine fault tolerance.
  Key functions: registerEntity(), verifyQuorum(), updateEntitySet()

- **SubcontractProvider.sol** (139 lines)
  Subcontract lifecycle management. Enables dynamic entity relationships.
  Key functions: createSubcontract(), updateState(), settleSubcontract()

### ⚡ Runtime Layer (runtime/)
- **runtime.ts** (1093 lines)
  Main coordinator. Routes inputs every 100ms tick: Runtime → Entity → Account.
  Manages global state via ServerFrames. Side-effectful shell for consensus.

- **entity-consensus.ts** (953 lines)
  BFT consensus state machine. Flow: ADD_TX → PROPOSE → SIGN → COMMIT.
  Pure functional: (prevState, input) → {nextState, outbox}

- **evm.ts** (920 lines)
  Blockchain integration. Connects to Depository/EntityProvider contracts.
  Handles batch submissions and jurisdiction management.

- **account-consensus.ts** (674 lines)
  Bilateral consensus between entity pairs. Left/right perspective handling.
  Deterministic state verification via snapshot-coder.

- **types.ts** (565 lines)
  All TypeScript interfaces. Single source of truth for data structures.
  Includes: Entity, Account, Transaction, Frame types.

- **state-helpers.ts** (313 lines)
  Pure state management utilities. Immutable operations on consensus state.
  Key functions: cloneState(), applyTransaction(), computeStateRoot()

- **snapshot-coder.ts** (239 lines)
  Deterministic state serialization. RLP encoding for consensus verification.
  encode(state) → Buffer, decode(Buffer) → state

### 📚 Documentation (vibepaper/)
- **xlnview.md** - High-level system overview and mental model
- **emc2.md** - Core philosophy: Energy-Mass-Credit equivalence
- **docs/summary.md** - Executive summary for quick orientation
- **docs/consensus/transaction-flow-specification.md** - Detailed transaction flows
- **docs/11_Jurisdiction_Machine.md** - Architecture patterns and state machines

---

## Reading Guide for LLMs

1. **Start with types.ts** - Understand the data structures
2. **Read entity-consensus.ts** - Core BFT consensus logic
3. **Review Depository.sol + EntityProvider.sol** - On-chain anchoring
4. **Check runtime.ts** - How everything connects
5. **Reference docs/** - For context and rationale

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

console.log('✅ XLN context generated successfully!');
console.log(`📄 Output: ${outputPath}`);
console.log(`📊 Stats: ${lines} lines, ${kb} KB`);
console.log(`🌐 URL: xln.finance/c.txt`);
console.log('');
console.log('Core files included:');
console.log(`  🔐 Contracts: ${CORE_FILES.contracts.length}`);
console.log(`  ⚡ Runtime: ${CORE_FILES.runtime.length}`);
console.log(`  📚 Docs: ${CORE_FILES.docs.length}`);
