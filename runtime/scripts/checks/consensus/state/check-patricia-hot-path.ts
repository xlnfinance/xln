/** Prevent a regression to sorting or map lookup at every Patricia branch. */
import ts from 'typescript';

const files = [
  'runtime/protocol/state/persistent-radix-value-build.ts',
  'runtime/protocol/state/persistent-radix-value-map.ts',
] as const;
const violations: string[] = [];

const report = (source: ts.SourceFile, node: ts.Node, code: string): void => {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  violations.push(`${source.fileName}:${position.line + 1}:${code}`);
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
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (violations.length > 0) {
  throw new Error(`PATRICIA_HOT_PATH_REGRESSION:${violations.length}\n${violations.join('\n')}`);
}
console.log('PATRICIA_HOT_PATH_OK');
