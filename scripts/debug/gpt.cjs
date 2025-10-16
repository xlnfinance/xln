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

    // V1 implementations (simnet/testnet ready)
    'DepositoryV1.sol',      // Implements IDepository - reserve/collateral management
    'EntityProviderV1.sol',  // Implements IEntityProvider - Hanko, governance, C/D shares
    'SubcontractProviderV1.sol', // Implements ISubcontractProvider - HTLCs, swaps, limit orders
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

function countLines(content) {
  return content.split('\n').length;
}

function generateSemanticOverview(contractsDir, runtimeDir, docsDir) {
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

  return `# XLN Context - Core System Files
## Cross-Local Network: Off-chain settlement with on-chain anchoring

xln/
  jurisdictions/contracts/
    IDepository.sol              ${fileSizes['contracts/IDepository.sol'] || '?'} lines - Reserve-Credit interface (INVARIANT: leftDiff + rightDiff + collateralDiff == 0)
    IEntityProvider.sol          ${fileSizes['contracts/IEntityProvider.sol'] || '?'} lines - Entity Governance & Hanko Verification
    ISubcontractProvider.sol     ${fileSizes['contracts/ISubcontractProvider.sol'] || '?'} lines - Bilateral Logic (delta transformers)
    DepositoryV1.sol             ${fileSizes['contracts/DepositoryV1.sol'] || '?'} lines - enforceDebts() FIFO, collateral + credit
    EntityProviderV1.sol         ${fileSizes['contracts/EntityProviderV1.sol'] || '?'} lines - Hanko sigs, Control/Dividend, governance
    SubcontractProviderV1.sol    ${fileSizes['contracts/SubcontractProviderV1.sol'] || '?'} lines - HTLCs, swaps, limit orders

  runtime/
    runtime.ts                   ${fileSizes['runtime/runtime.ts'] || '?'} lines - Main coordinator, 100ms ticks, R->E->A routing
    entity-consensus.ts          ${fileSizes['runtime/entity-consensus.ts'] || '?'} lines - BFT consensus (ADD_TX -> PROPOSE -> SIGN -> COMMIT)
    evm.ts                       ${fileSizes['runtime/evm.ts'] || '?'} lines - Blockchain integration, BrowserVM + testnet
    account-consensus.ts         ${fileSizes['runtime/account-consensus.ts'] || '?'} lines - Bilateral consensus, left/right perspective
    types.ts                     ${fileSizes['runtime/types.ts'] || '?'} lines - All TypeScript interfaces
    state-helpers.ts             ${fileSizes['runtime/state-helpers.ts'] || '?'} lines - Pure state management
    snapshot-coder.ts            ${fileSizes['runtime/snapshot-coder.ts'] || '?'} lines - Deterministic RLP serialization

  vibepaper/
    xlnview.md                   ${fileSizes['vibepaper/xlnview.md'] || '?'} lines - System overview, panel architecture
    emc2.md                      ${fileSizes['vibepaper/emc2.md'] || '?'} lines - Energy-Mass-Credit equivalence
    priorart.md                  ${fileSizes['vibepaper/priorart.md'] || '?'} lines - * WHY LIGHTNING/ROLLUPS DON'T WORK
    docs/00_QA.md                ${fileSizes['vibepaper/docs/00_QA.md'] || '?'} lines - Value prop FAQs
    docs/12_invariant.md         ${fileSizes['vibepaper/docs/12_invariant.md'] || '?'} lines - * RCPE innovation (core primitive)
    docs/jea.md                  ${fileSizes['vibepaper/docs/jea.md'] || '?'} lines - Jurisdiction-Entity-Account model
    docs/summary.md              ${fileSizes['vibepaper/docs/summary.md'] || '?'} lines - Executive summary
    docs/consensus/transaction-flow-specification.md  ${fileSizes['vibepaper/docs/consensus/transaction-flow-specification.md'] || '?'} lines
    docs/11_Jurisdiction_Machine.md  ${fileSizes['vibepaper/docs/11_Jurisdiction_Machine.md'] || '?'} lines - Architecture

Reading Guide: 1) docs/12_invariant.md (RCPE), 2) IDepository.sol, 3) types.ts, 4) entity-consensus.ts + account-consensus.ts, 5) runtime.ts

Note: ECDSA.sol = OpenZeppelin, Token.sol = test ERC20, console.sol = Hardhat logging (not included - boilerplate)

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

  let output = generateSemanticOverview(contractsDir, runtimeDir, docsDir);

  // Process contracts
  CORE_FILES.contracts.forEach(file => {
    const content = readFileContent(contractsDir, file);
    if (content) {
      const lines = countLines(content);
      output += `\n//jurisdictions/contracts/${file} (${lines} lines)\n`;
      output += content + '\n';
    }
  });

  // Process runtime files
  CORE_FILES.runtime.forEach(file => {
    const content = readFileContent(runtimeDir, file);
    if (content) {
      const lines = countLines(content);
      output += `\n//runtime/${file} (${lines} lines)\n`;
      output += content + '\n';
    }
  });

  // Process documentation
  CORE_FILES.docs.forEach(file => {
    const content = readFileContent(docsDir, file);
    if (content) {
      const lines = countLines(content);
      output += `\n//vibepaper/${file} (${lines} lines)\n`;
      output += content + '\n';
    }
  });

  // Meta: Include this script itself at the very end
  output += '\n//META: Generated by scripts/debug/gpt.cjs\n';
  const scriptContent = readFileContent(projectRoot, 'scripts/debug/gpt.cjs');
  if (scriptContent) {
    output += `\n//scripts/debug/gpt.cjs\n`;
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

console.log('✅ c.txt generated');
console.log(`📊 ${lines.toLocaleString()} lines, ${kb} KB, ~${tokensRealistic.toLocaleString()} tokens`);
console.log(`🌐 xln.finance/c.txt`);
console.log(`📁 Contracts: ${CORE_FILES.contracts.length} | Runtime: ${CORE_FILES.runtime.length} | Docs: ${CORE_FILES.docs.length}`);
