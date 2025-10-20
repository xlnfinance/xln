// XLN Context Generator - Creates ultra-compact LLM-friendly context
// Output: frontend/static/c.txt (accessible at xln.finance/c.txt)
const fs = require('fs');
const path = require('path');

// ⭐ CORE FILES ONLY - Everything an LLM needs to understand XLN
const CORE_FILES = {
  contracts: [
    'Depository.sol',      // Reserve/collateral management, enforceDebts FIFO
    'EntityProvider.sol',  // Hanko verification, governance, C/D shares
    'SubcontractProvider.sol', // HTLCs, swaps, limit orders
  ],
  runtime: [
    // Core types and data structures (read this first)
    'types.ts',              // All TypeScript interfaces - START HERE

    // Main coordinators (how the system works)
    'runtime.ts',            // Main coordinator, 100ms ticks, R→E→A routing
    'entity-consensus.ts',   // BFT consensus (ADD_TX → PROPOSE → SIGN → COMMIT)
    'account-consensus.ts',  // Bilateral account consensus between entities

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
    'emc2.md',               // Core philosophy: E=mc² → Energy-Mass-Credit
    'priorart.md',           // Why Lightning/rollups don't work
    'docs/summary.md',       // Executive summary
    'docs/00_QA.md',         // FAQs: value prop, positioning, architecture
    'docs/12_invariant.md',  // RCPE vs FCUAN vs FRPAP (THE core innovation)
    'docs/jea.md',           // Jurisdiction-Entity-Account 3-layer model
    'docs/consensus/transaction-flow-specification.md', // Transaction flows
    'docs/11_Jurisdiction_Machine.md' // Architecture deep-dive
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
## Cross-Local Network: Off-chain settlement with on-chain anchoring

xln/
  jurisdictions/contracts/
    Depository.sol             ${fileSizes['contracts/Depository.sol'] || '?'} lines - enforceDebts() FIFO, collateral + credit (INVARIANT: L+R+C=0)
    EntityProvider.sol         ${fileSizes['contracts/EntityProvider.sol'] || '?'} lines - Hanko sigs, Control/Dividend, governance
    SubcontractProvider.sol    ${fileSizes['contracts/SubcontractProvider.sol'] || '?'} lines - HTLCs, swaps, limit orders

  runtime/
    types.ts                     ${fileSizes['runtime/types.ts'] || '?'} lines - All TypeScript interfaces (START HERE)
    runtime.ts                   ${fileSizes['runtime/runtime.ts'] || '?'} lines - Main coordinator, 100ms ticks, R->E->A routing
    entity-consensus.ts          ${fileSizes['runtime/entity-consensus.ts'] || '?'} lines - BFT consensus (ADD_TX -> PROPOSE -> SIGN -> COMMIT)
    account-consensus.ts         ${fileSizes['runtime/account-consensus.ts'] || '?'} lines - Bilateral consensus, left/right perspective

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
    emc2.md                      ${fileSizes['vibepaper/emc2.md'] || '?'} lines - Energy-Mass-Credit equivalence
    priorart.md                  ${fileSizes['vibepaper/priorart.md'] || '?'} lines - * WHY LIGHTNING/ROLLUPS DON'T WORK
    docs/00_QA.md                ${fileSizes['vibepaper/docs/00_QA.md'] || '?'} lines - Value prop FAQs
    docs/12_invariant.md         ${fileSizes['vibepaper/docs/12_invariant.md'] || '?'} lines - * RCPE innovation (core primitive)
    docs/jea.md                  ${fileSizes['vibepaper/docs/jea.md'] || '?'} lines - Jurisdiction-Entity-Account model
    docs/summary.md              ${fileSizes['vibepaper/docs/summary.md'] || '?'} lines - Executive summary
    docs/consensus/transaction-flow-specification.md  ${fileSizes['vibepaper/docs/consensus/transaction-flow-specification.md'] || '?'} lines
    docs/11_Jurisdiction_Machine.md  ${fileSizes['vibepaper/docs/11_Jurisdiction_Machine.md'] || '?'} lines - Architecture

  worlds/
    architecture.md              ${fileSizes['worlds/architecture.md'] || '?'} lines - Scenario architecture, EntityInput primitives

Reading Guide: 1) types.ts (data structures), 2) docs/12_invariant.md (RCPE), 3) Depository.sol (enforceDebts), 4) entity-consensus.ts + account-consensus.ts, 5) entity-tx/apply.ts + account-tx/apply.ts, 6) runtime.ts

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
const tokensTotal = Math.round(bytes / 3.5);

console.log('✅ c.txt generated');
console.log(`📊 ${lines.toLocaleString()} lines, ${kb} KB, ~${tokensTotal.toLocaleString()} tokens`);
console.log(`🌐 xln.finance/c.txt`);
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
