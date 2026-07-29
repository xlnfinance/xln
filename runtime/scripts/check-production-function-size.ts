import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const MAX_FILE_LINES = 3_000;
const MAX_COORDINATOR_LINES = 150;
const EXCLUDED_PATH = /\/(?:__tests__|qa|scenarios|scripts)\//;

// This is debt, not permission to add more. Every entry is tied to one exact
// production function and its current maximum. A function that grows, a new
// large function, or a completed refactor whose allowance was not removed
// fails the gate. The only healthy direction is toward an empty object.
const COORDINATOR_DEBT: Readonly<Record<string, number>> = {
  "runtime/api/external-wallet-api.ts::createExternalWalletApi": 331,
  "runtime/jadapter/browservm-ethers-provider.ts::_perform": 158,
  "runtime/jadapter/browservm.ts::createBrowserVMAdapter": 581,
  "runtime/jadapter/helpers.ts::buildRawJEventsRuntimeInput": 228,
  "runtime/jadapter/helpers.ts::rawEventToJEventPayloads": 297,
  "runtime/jadapter/rpc-adapter.ts::createRpcAdapter": 2880,
  "runtime/jadapter/rpc-adapter.ts::deployStack": 167,
  "runtime/jadapter/rpc-adapter.ts::doPoll": 525,
  "runtime/jadapter/rpc-adapter.ts::pollInFlight callback": 436,
  "runtime/jadapter/rpc-adapter.ts::reconcileWatcherCanonicalTip": 171,
  "runtime/jadapter/rpc-adapter.ts::runSerializedBatch callback": 280,
  "runtime/jadapter/rpc-adapter.ts::startWatching": 1040,
  "runtime/jadapter/rpc-adapter.ts::submitTx": 489,
  "runtime/jadapter/rpc-reads.ts::createRpcReadMethods": 275,
  "runtime/jadapter/rpc-reads.ts::readWalletSnapshot": 155,
  "runtime/jadapter/rpc-wallet-writes.ts::createRpcWalletWriteMethods": 160,
  "runtime/jurisdiction/event-normalization.ts::normalizeJurisdictionEvent": 399,
  "runtime/orchestrator/bootstrap-timeline.ts::buildBootstrapTimeline": 206,
  "runtime/orchestrator/bootstrap-timeline.ts::createBootstrapTimelineTools": 339,
  "runtime/orchestrator/hub-node.ts::driveMeshBootstrap": 208,
  "runtime/orchestrator/hub-node.ts::fetch": 323,
  "runtime/orchestrator/hub-node.ts::run": 1064,
  "runtime/orchestrator/mm-node-core.ts::buildMarketMakerCrossOfferSpecs": 151,
  "runtime/orchestrator/mm-node-health.ts::maintainMarketMakerCrossQuotes": 409,
  "runtime/orchestrator/mm-node-run.ts::driveQuotes": 334,
  "runtime/orchestrator/mm-node-run.ts::runMarketMakerNode": 1707,
  "runtime/orchestrator/mm-node-run.ts::waitForBootstrapOffers": 207,
  "runtime/orchestrator/orchestrator.ts::computeAggregatedHealth": 270,
  "runtime/orchestrator/orchestrator.ts::fetch": 388,
  "runtime/orchestrator/orchestrator.ts::runReset": 156,
  "runtime/orchestrator/orchestrator.ts::spawnMarketMaker": 159,
  "runtime/protocol/dispute/proof-builder.ts::buildAccountProofBody": 172,
  "runtime/protocol/htlc/onion-advance.ts::validateHtlcOnionAdvanceTx": 213,
  "runtime/radapter/resolve.ts::projectGraphFrame": 175,
  "runtime/radapter/resolve.ts::resolveRuntimeAdapterRead": 154,
  "runtime/radapter/server.ts::handleRuntimeAdapterMessage": 302,
  "runtime/recovery/restore.ts::createRuntimeRecoveryApi": 924,
  "runtime/recovery/restore.ts::replayRecoveryFrameJournals": 187,
  "runtime/server/index.ts::createHttpServer": 216,
  "runtime/server/index.ts::startXlnServer": 630,
  "runtime/server/token-catalog.ts::createTokenCatalogController": 165,
  "runtime/storage/merkle.ts::buildRadixMerkleMaterialized": 181,
  "runtime/storage/restore-import.ts::replaceRestoredStorageBase": 152,
  "runtime/watchtower/action.ts::runWatchtowerSweep": 159,
  "runtime/watchtower/store.ts::createWatchtowerStore": 372,
};

type FunctionSize = {
  key: string;
  file: string;
  name: string;
  lines: number;
  start: number;
};

const collectFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(target);
    if (!entry.isFile() || !target.endsWith('.ts') || target.endsWith('.d.ts')) return [];
    return EXCLUDED_PATH.test(`/${target}`) || target.endsWith('.test.ts') || target.endsWith('.spec.ts')
      ? []
      : [target];
  });

const callbackOwner = (node: ts.FunctionLikeDeclaration, source: ts.SourceFile): string | null => {
  let parent: ts.Node | undefined = node.parent;
  while (parent && !ts.isFunctionLike(parent)) {
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return `${parent.left.getText(source)} callback`;
    }
    if (ts.isCallExpression(parent)) {
      const expression = parent.expression.getText(source);
      if (!expression.startsWith('(')) return `${expression} callback`;
    }
    parent = parent.parent;
  }
  return null;
};

const functionName = (
  node: ts.FunctionLikeDeclaration,
  source: ts.SourceFile,
  start: number,
): string => {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (ts.isMethodDeclaration(node) && node.name) return node.name.getText(source);
  return callbackOwner(node, source) ?? `anonymous@${start}`;
};

const collectFunctionSizes = (file: string, text: string): FunctionSize[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions: FunctionSize[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && 'body' in node && node.body) {
      const declaration = node as ts.FunctionLikeDeclaration;
      const start = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(declaration.end).line + 1;
      const name = functionName(declaration, source, start);
      functions.push({ key: `${file}::${name}`, file, name, lines: end - start + 1, start });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return functions;
};

const files = collectFiles('runtime').sort();
const functions: FunctionSize[] = [];
const errors: string[] = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).length;
  if (lines > MAX_FILE_LINES) errors.push(`FILE_TOO_LARGE ${file}:${lines} > ${MAX_FILE_LINES}`);
  functions.push(...collectFunctionSizes(file, text));
}

const currentDebt = new Map<string, FunctionSize>();
for (const entry of functions.filter(item => item.lines > MAX_COORDINATOR_LINES)) {
  if (currentDebt.has(entry.key)) errors.push(`DUPLICATE_FUNCTION_KEY ${entry.key}`);
  currentDebt.set(entry.key, entry);
  const allowance = COORDINATOR_DEBT[entry.key];
  if (allowance === undefined) errors.push(`NEW_LARGE_FUNCTION ${entry.key}:${entry.start} lines=${entry.lines}`);
  else if (entry.lines > allowance) errors.push(`LARGE_FUNCTION_GREW ${entry.key}:${entry.start} ${entry.lines} > ${allowance}`);
}

for (const key of Object.keys(COORDINATOR_DEBT)) {
  if (!currentDebt.has(key)) errors.push(`STALE_LARGE_FUNCTION_ALLOWANCE ${key}`);
}

if (errors.length > 0) {
  console.error('Production function-size invariant failed:\n');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `PRODUCTION_FUNCTION_SIZE_OK files=${files.length} maxFile=${MAX_FILE_LINES} ` +
  `over150=${currentDebt.size}/${Object.keys(COORDINATOR_DEBT).length}`,
);
