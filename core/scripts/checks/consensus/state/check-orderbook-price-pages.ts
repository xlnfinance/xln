/** Prevent regression to O(Book) bucket/link topology or duplicated disk indexes. */
import ts from 'typescript';

const configPath = ts.findConfigFile('.', ts.sys.fileExists, 'tsconfig.runtime.json');
if (!configPath) throw new Error('ORDERBOOK_PAGE_GATE_TSCONFIG_MISSING');
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, '.', undefined, configPath);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const violations: string[] = [];

const LEGACY_NAMES = new Set([
  'bidBuckets', 'askBuckets', 'bidBucketIdsDesc', 'askBucketIdsAsc',
  'previousOrderId', 'nextOrderId', 'PriceBucketState', 'PriceLevelState',
  'getWritableBookLevel',
]);
const SCOPES = [
  '/core/orderbook/',
  '/core/storage/',
  '/core/api/runtime-adapter/',
  '/core/entity/tx/handlers/account/orderbook/',
  '/core/scripts/operations/hlt/',
];

const report = (source: ts.SourceFile, node: ts.Node, code: string): void => {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  violations.push(`${source.fileName}:${position.line + 1}:${code}`);
};

const visitLegacy = (source: ts.SourceFile, node: ts.Node): void => {
  if (ts.isIdentifier(node) && LEGACY_NAMES.has(node.text)) report(source, node, `legacy-${node.text}`);
  ts.forEachChild(node, child => visitLegacy(source, child));
};

const findFunction = (source: ts.SourceFile, name: string): ts.Node | undefined => {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
      (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
    ) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const checkHotMatcher = (source: ts.SourceFile): void => {
  const matcher = findFunction(source, 'matchPricePages');
  if (!matcher) return report(source, source, 'hot-matcher-missing');
  const forbidden = new Set(['getBookOrders']);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && forbidden.has(node.text)) report(source, node, `hot-scan-${node.text}`);
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ['sort', 'entries', 'values', 'keys'].includes(node.expression.name.text)
    ) report(source, node, `hot-iteration-${node.expression.name.text}`);
    ts.forEachChild(node, visit);
  };
  visit(matcher);
};

const checkAuthorityPass = (source: ts.SourceFile): void => {
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'orders' &&
      ['entries', 'keys', 'values', 'forEach'].includes(node.expression.name.text)
    ) report(source, node, `authority-full-book-${node.expression.name.text}`);
    if (
      ts.isSpreadElement(node) && ts.isCallExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'orders'
    ) report(source, node, 'authority-full-book-spread');
    ts.forEachChild(node, visit);
  };
  visit(source);
};

for (const source of program.getSourceFiles()) {
  const path = source.fileName.replaceAll('\\', '/');
  if (!path.includes('/core/') || path.includes('/core/__tests__/')) continue;
  if (SCOPES.some(scope => path.includes(scope))) visitLegacy(source, source);
  if (path.endsWith('/core/orderbook/core.ts')) checkHotMatcher(source);
  if (
    path.endsWith('/core/entity/tx/handlers/account/orderbook/same/pass.ts') ||
    path.endsWith('/core/entity/tx/handlers/account/orderbook/cross/book.ts')
  ) checkAuthorityPass(source);
}

const storageFiles = program.getSourceFiles().filter(source =>
  source.fileName.replaceAll('\\', '/').includes('/core/storage/'));
for (const source of storageFiles) {
  const text = source.getFullText();
  if (text.includes('projectBookForStorage')) report(source, source, 'book-blob-projection');
  if (text.includes('projectBookPricePageTree')) report(source, source, 'book-flat-page-projection');
  if (text.includes('decodeBookPricePageTree')) report(source, source, 'book-flat-page-hydration');
}
const bookCodec = ts.sys.readFile('core/storage/schema/book-graph-codec.ts') ?? '';
if (!bookCodec.includes('projectStorageBookGraphChanges')) {
  violations.push('core/storage/schema/book-graph-codec.ts:dirty-path-writer-missing');
}
const storageIndex = ts.sys.readFile('core/storage/index.ts') ?? '';
if (!storageIndex.includes('bookGraphWrites')) {
  violations.push('core/storage/index.ts:book-graph-batch-missing');
}

if (violations.length > 0) throw new Error(`ORDERBOOK_PRICE_PAGE_GATE:${violations.length}\n${violations.sort().join('\n')}`);
console.log('ORDERBOOK_PRICE_PAGE_ARCHITECTURE_OK');
