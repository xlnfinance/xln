/** Prevent a regression to sorting or map lookup at every Patricia branch. */
import ts from 'typescript';

const files = [
  'runtime/protocol/state/persistent-radix-value-build.ts',
  'runtime/protocol/state/persistent-radix-value-ops.ts',
  'runtime/protocol/state/persistent-radix-value-map.ts',
  'runtime/protocol/state/radix-overlay.ts',
  'runtime/entity/state/persistent-account-map.ts',
  'runtime/entity/state/persistent-collection-map.ts',
  'runtime/orderbook/book-overlay.ts',
] as const;
const violations: string[] = [];

const report = (source: ts.SourceFile, node: ts.Node, code: string): void => {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  violations.push(`${source.fileName}:${position.line + 1}:${code}`);
};

const isLoop = (node: ts.Node): boolean =>
  ts.isForStatement(node) || ts.isForInStatement(node) ||
  ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);

const hasLoopAncestor = (node: ts.Node, source: ts.SourceFile): boolean => {
  let current = node.parent;
  while (current && current !== source) {
    if (isLoop(current)) return true;
    current = current.parent;
  }
  return false;
};

for (const file of files) {
  const text = ts.sys.readFile(file);
  if (text === undefined) throw new Error(`PATRICIA_HOT_PATH_FILE_MISSING:${file}`);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'children' &&
      ['get', 'set', 'delete', 'keys', 'entries'].includes(node.name.text)
    ) report(source, node, `branch-map-${node.name.text}`);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'sort' &&
      node.expression.expression.getText(source).includes('children')
    ) report(source, node, 'branch-runtime-sort');
    if (
      file.endsWith('radix-overlay.ts') &&
      ts.isPropertyAccessExpression(node) &&
      (node.name.text === 'updated' || node.name.text === 'removed')
    ) report(source, node, `overlay-repeated-${node.name.text}`);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'updated' || node.expression.name.text === 'removed') &&
      hasLoopAncestor(node, source)
    ) report(source, node, `loop-repeated-${node.expression.name.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

for (const file of ts.sys.readDirectory('runtime/protocol/state', ['.ts'])) {
  const text = ts.sys.readFile(file);
  if (text === undefined) throw new Error(`PATRICIA_HASH_OWNER_FILE_MISSING:${file}`);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (
      !file.endsWith('persistent-radix-value-ops.ts') &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const hashAssignment = ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'hash';
      const edgeAssignment = ts.isElementAccessExpression(node.left) &&
        ts.isPropertyAccessExpression(node.left.expression) &&
        node.left.expression.name.text === 'edgeHashes';
      if (hashAssignment || edgeAssignment) report(source, node, 'derived-hash-write-outside-owner');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (violations.length > 0) {
  throw new Error(`PATRICIA_HOT_PATH_REGRESSION:${violations.length}\n${violations.join('\n')}`);
}
console.log('PATRICIA_HOT_PATH_OK');
