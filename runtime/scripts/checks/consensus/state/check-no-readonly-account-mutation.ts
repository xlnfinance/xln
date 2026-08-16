/**
 * Reject writes through EntityState.accounts.get() and Account Patricia get().
 *
 * A read may return the certified Account object itself. Mutating that alias
 * bypasses the Entity Account overlay, so the Patricia leaf/root stays stale.
 * Production writes must first claim the bounded shell through
 * getEntityAccountForWrite().
 */
import ts from 'typescript';

const sourceGlobs = [
  new Bun.Glob('runtime/entity/**/*.ts'),
  new Bun.Glob('runtime/account/**/*.ts'),
] as const;
const mutatingMethods = new Set([
  'add', 'clear', 'copyWithin', 'delete', 'fill', 'pop', 'push',
  'reverse', 'set', 'shift', 'sort', 'splice', 'unshift',
]);
const accountCollectionFields = new Set([
  'deltas',
  'locks',
  'swapOffers',
  'pulls',
  'subcontracts',
  'lendingIntents',
  'requestedRebalance',
  'requestedRebalanceFeeState',
  'rebalanceFeePolicies',
  'pendingWithdrawals',
  'policy',
  'submittedAtByToken',
]);

const containsAccountRead = (node: ts.Node): boolean => {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'get' &&
    ts.isPropertyAccessExpression(node.expression.expression)
  ) {
    const collection = node.expression.expression.name.text;
    if (collection === 'accounts' || accountCollectionFields.has(collection)) return true;
  }
  return node.getChildren().some(containsAccountRead);
};

const rootIdentifier = (node: ts.Node): ts.Identifier | undefined => {
  if (ts.isIdentifier(node)) return node;
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) return rootIdentifier(node.expression);
  return undefined;
};

const containsTainted = (node: ts.Node, tainted: ReadonlySet<string>): boolean => {
  const root = rootIdentifier(node);
  if (root && tainted.has(root.text)) return true;
  return node.getChildren().some(child => containsTainted(child, tainted));
};

const isTaintedAlias = (
  node: ts.Expression,
  tainted: ReadonlySet<string>,
  accountReaderFunctions: ReadonlySet<string>,
): boolean => {
  if (ts.isCallExpression(node)) {
    if (containsAccountRead(node)) return true;
    if (ts.isIdentifier(node.expression) && accountReaderFunctions.has(node.expression.text)) return true;
  }
  if (ts.isConditionalExpression(node)) {
    return isTaintedAlias(node.whenTrue, tainted, accountReaderFunctions)
      || isTaintedAlias(node.whenFalse, tainted, accountReaderFunctions);
  }
  const root = rootIdentifier(node);
  return root !== undefined && tainted.has(root.text);
};

const assignmentOperator = (kind: ts.SyntaxKind): boolean =>
  kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

const collectFunctionViolations = (
  source: ts.SourceFile,
  fn: ts.FunctionLikeDeclaration,
  accountReaderFunctions: ReadonlySet<string>,
  output: string[],
): void => {
  if (!fn.body) return;
  const tainted = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const discover = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (containsAccountRead(node.initializer)
          || isTaintedAlias(node.initializer, tainted, accountReaderFunctions)) &&
        !tainted.has(node.name.text)
      ) {
        tainted.add(node.name.text);
        changed = true;
      }
      ts.forEachChild(node, discover);
    };
    discover(fn.body);
  }

  const record = (node: ts.Node): void => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    output.push(`${source.fileName}:${position.line + 1}:readonly-account-mutation`);
  };
  const inspect = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      assignmentOperator(node.operatorToken.kind) &&
      containsTainted(node.left, tainted)
    ) record(node);
    else if (
      ts.isDeleteExpression(node) &&
      containsTainted(node.expression, tainted)
    ) record(node);
    else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      containsTainted(node.operand, tainted)
    ) record(node);
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      mutatingMethods.has(node.expression.name.text) &&
      containsTainted(node.expression.expression, tainted)
    ) record(node);
    ts.forEachChild(node, inspect);
  };
  inspect(fn.body);
};

const functionName = (fn: ts.FunctionLikeDeclaration): string | undefined => {
  if ('name' in fn && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return undefined;
};

/**
 * Account-reader helpers carry the same read-only alias across a call boundary.
 * Without this file-local propagation a helper such as accountByCounterparty()
 * can hide the exact mutation the gate is meant to reject.
 */
const collectAccountReaderFunctions = (source: ts.SourceFile): ReadonlySet<string> => {
  const readers = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
      ) {
        const name = functionName(node);
        if (name && node.body && !readers.has(name)) {
          const bodyReturnsAccount = !ts.isBlock(node.body)
            ? containsAccountRead(node.body)
            : node.body.statements.some(statement =>
                ts.isReturnStatement(statement)
                && statement.expression !== undefined
                && (containsAccountRead(statement.expression)
                  || (ts.isCallExpression(statement.expression)
                    && ts.isIdentifier(statement.expression.expression)
                    && readers.has(statement.expression.expression.text))));
          if (bodyReturnsAccount) {
            readers.add(name);
            changed = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return readers;
};

const violations: string[] = [];
for (const files of sourceGlobs) {
  for await (const file of files.scan({ cwd: process.cwd(), absolute: true })) {
    if (file.includes('/__tests__/') || file.includes('/scripts/')) continue;
    const source = ts.createSourceFile(
      file,
      await Bun.file(file).text(),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const accountReaderFunctions = collectAccountReaderFunctions(source);
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
      ) collectFunctionViolations(source, node, accountReaderFunctions, violations);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

if (violations.length > 0) {
  console.error(`NO_READONLY_ACCOUNT_MUTATION_FAILED count=${violations.length}`);
  for (const violation of violations) console.error(violation);
  process.exit(1);
}
console.log('NO_READONLY_ACCOUNT_MUTATION_OK');
