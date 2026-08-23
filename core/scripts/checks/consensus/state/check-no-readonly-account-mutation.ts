/**
 * Reject writes through EntityState growing collections and Account Patricia
 * reads. Both return certified values; handlers must claim a writable leaf.
 *
 * A read may return the certified Account object itself. Mutating that alias
 * bypasses the Entity Account overlay, so the Patricia leaf/root stays stale.
 * Production writes must first claim the bounded shell through
 * getEntityAccountForWrite().
 */
import ts from 'typescript';

const sourceGlobs = [new Bun.Glob('core/**/*.ts')] as const;
const mutatingMethods = new Set([
  'add',
  'clear',
  'copyWithin',
  'delete',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
]);
const staticMutators = new Map<string, ReadonlySet<string>>([
  ['Object', new Set(['assign', 'defineProperties', 'defineProperty', 'setPrototypeOf'])],
  ['Reflect', new Set(['defineProperty', 'deleteProperty', 'set', 'setPrototypeOf'])],
]);
const accountCollectionFields = new Set([
  'crossJurisdictionAuthorizations',
  'crossJurisdictionBookAdmissions',
  'crossJurisdictionSwaps',
  'deltas',
  'htlcRoutes',
  'lockBook',
  'locks',
  'pendingCrossJurisdictionFillAcks',
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

/**
 * Account envelope fields shared by reference in forkAccountDraftShell
 * (lever S, commit 963a1dc0a). Handlers receive an AccountDraftReplica whose
 * envelope fields point at the committed replica's objects. In-place mutation
 * of these fields corrupts the committed state; field reassignment on the
 * draft is safe (only affects the draft shell).
 */
const accountEnvelopeFields = new Set([
  'mempool',
  'currentFrame',
  'pendingFrame',
  'pendingAccountInput',
  'lastOutboundFrameAck',
  'disputePrepare',
  'activeDispute',
  'boardResealMigration',
  'counterpartyBoardReseal',
]);

/**
 * Parameter whose type annotation includes "DraftReplica". The AST scan does
 * not resolve types, so this is a text-level heuristic on the type reference
 * name. AccountDraftReplica is the only *Replica type with "Draft" in its
 * name, so false positives are unlikely.
 */
const isDraftTypedParameter = (param: ts.ParameterDeclaration): boolean => {
  if (!param.type || !ts.isTypeReferenceNode(param.type)) return false;
  const typeName = param.type.typeName;
  const text = ts.isIdentifier(typeName) ? typeName.text : ts.isQualifiedName(typeName) ? typeName.right.text : '';
  return text.includes('DraftReplica');
};

const bindingNameText = (name: ts.BindingName): string | undefined => {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isObjectBindingPattern(name)) return undefined;
  if (ts.isArrayBindingPattern(name)) return undefined;
  return undefined;
};

/**
 * True if the node is a property access to an envelope field through a
 * draft-tainted variable: account.mempool where account is draft-tainted.
 */
const isEnvelopeFieldAccess = (node: ts.Node, draftTainted: ReadonlySet<string>): boolean => {
  if (ts.isPropertyAccessExpression(node) && accountEnvelopeFields.has(node.name.text)) {
    const root = rootIdentifier(node.expression);
    if (root && draftTainted.has(root.text)) return true;
  }
  return false;
};

/**
 * True if the node is an "envelope-unsafe receiver" — an object obtained from
 * a draft's envelope field that must not be mutated in place.
 *
 * Matches:
 *   account.mempool        (envelope field access through draft-tainted)
 *   mp                     (variable holding an envelope field reference)
 *   account.mempool[0]     (element access on envelope field)
 *   mp.subField            (property access on envelope-tainted variable)
 *   (account.mempool)      (parenthesized wrapper)
 */
const isEnvelopeUnsafeReceiver = (
  node: ts.Node,
  draftTainted: ReadonlySet<string>,
  envelopeTainted: ReadonlySet<string>,
): boolean => {
  if (ts.isIdentifier(node)) return envelopeTainted.has(node.text);
  if (ts.isParenthesizedExpression(node)) {
    return isEnvelopeUnsafeReceiver(node.expression, draftTainted, envelopeTainted);
  }
  if (isEnvelopeFieldAccess(node, draftTainted)) return true;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return isEnvelopeUnsafeReceiver(node.expression, draftTainted, envelopeTainted);
  }
  return false;
};

/**
 * Destructured bindings that extract envelope fields from a draft-tainted
 * variable: const { mempool } = account → mempool is envelope-tainted.
 */
const envelopeBindingsFromDestructure = (pattern: ts.ObjectBindingPattern): readonly string[] => {
  const names: string[] = [];
  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) continue;
    // Shorthand { mempool } has propertyName === undefined; the bound name
    // is both the property name and the variable name.
    const prop = element.propertyName;
    const propName =
      prop && ts.isIdentifier(prop) ? prop.text : ts.isIdentifier(element.name) ? element.name.text : undefined;
    if (propName === undefined || !accountEnvelopeFields.has(propName)) continue;
    const bound = bindingNameText(element.name);
    if (bound) names.push(bound);
  }
  return names;
};

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

const containsEntityAccounts = (node: ts.Node): boolean => {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'accounts') return true;
  return node.getChildren().some(containsEntityAccounts);
};

const declaresAccountIterationValue = (name: ts.BindingName, iterable: ts.Expression): readonly string[] => {
  if (!containsEntityAccounts(iterable)) return [];
  if (ts.isCallExpression(iterable) && ts.isPropertyAccessExpression(iterable.expression)) {
    const method = iterable.expression.name.text;
    if (method === 'keys') return [];
    if (method === 'values' && ts.isIdentifier(name)) return [name.text];
  }
  if (ts.isArrayBindingPattern(name)) {
    const value = name.elements[1];
    return value && ts.isBindingElement(value) && ts.isIdentifier(value.name) ? [value.name.text] : [];
  }
  return ts.isIdentifier(name) ? [name.text] : [];
};

const rootIdentifier = (node: ts.Node): ts.Identifier | undefined => {
  if (ts.isIdentifier(node)) return node;
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    return rootIdentifier(node.expression);
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
    return (
      isTaintedAlias(node.whenTrue, tainted, accountReaderFunctions) ||
      isTaintedAlias(node.whenFalse, tainted, accountReaderFunctions)
    );
  }
  const root = rootIdentifier(node);
  return root !== undefined && tainted.has(root.text);
};

const assignmentOperator = (kind: ts.SyntaxKind): boolean =>
  kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

type MutatingParameterFunctions = ReadonlyMap<string, ReadonlySet<number>>;

const collectFunctionViolations = (
  source: ts.SourceFile,
  fn: ts.FunctionLikeDeclaration,
  accountReaderFunctions: ReadonlySet<string>,
  mutatingParameterFunctions: MutatingParameterFunctions,
  output: string[],
): void => {
  if (!fn.body) return;
  const tainted = new Set<string>();
  // Draft-tainted: parameters typed as AccountDraftReplica. Envelope fields
  // on these are shared references (lever S); in-place mutation corrupts the
  // committed replica.
  const draftTainted = new Set<string>();
  for (const param of fn.parameters) {
    if (isDraftTypedParameter(param) && ts.isIdentifier(param.name)) {
      draftTainted.add(param.name.text);
    }
  }
  // Envelope-tainted: variables holding a reference obtained from a draft's
  // envelope field (const mp = account.mempool). Mutating these in place
  // mutates the shared object.
  const envelopeTainted = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const discover = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (containsAccountRead(node.initializer) || isTaintedAlias(node.initializer, tainted, accountReaderFunctions)) &&
        !tainted.has(node.name.text)
      ) {
        tainted.add(node.name.text);
        changed = true;
      }
      // Envelope taint: const mp = account.mempool (draft-tainted . envelopeField)
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        !envelopeTainted.has(node.name.text)
      ) {
        const init = node.initializer;
        if (isEnvelopeFieldAccess(init, draftTainted)) {
          envelopeTainted.add(node.name.text);
          changed = true;
        } else {
          const root = rootIdentifier(init);
          if (root && envelopeTainted.has(root.text)) {
            envelopeTainted.add(node.name.text);
            changed = true;
          }
        }
      }
      // Envelope taint via destructuring: const { mempool } = account
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        const initRoot = rootIdentifier(node.initializer);
        if (initRoot && draftTainted.has(initRoot.text)) {
          for (const bound of envelopeBindingsFromDestructure(node.name)) {
            if (!envelopeTainted.has(bound)) {
              envelopeTainted.add(bound);
              changed = true;
            }
          }
        }
      }
      if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          for (const name of declaresAccountIterationValue(declaration.name, node.expression)) {
            if (!tainted.has(name)) {
              tainted.add(name);
              changed = true;
            }
          }
        }
      }
      ts.forEachChild(node, discover);
    };
    discover(fn.body);
  }

  const record = (node: ts.Node): void => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    output.push(`${source.fileName}:${position.line + 1}:readonly-account-mutation`);
  };
  const envelopeUnsafe = (n: ts.Node): boolean => isEnvelopeUnsafeReceiver(n, draftTainted, envelopeTainted);
  const inspect = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      assignmentOperator(node.operatorToken.kind) &&
      (containsTainted(node.left, tainted) || containsAccountRead(node.left))
    )
      record(node);
    // Envelope in-place mutation: account.currentFrame.height = 5
    // (left is a property/element access whose object is envelope-unsafe)
    else if (
      ts.isBinaryExpression(node) &&
      assignmentOperator(node.operatorToken.kind) &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
      envelopeUnsafe(node.left.expression)
    )
      record(node);
    else if (
      ts.isDeleteExpression(node) &&
      (containsTainted(node.expression, tainted) || containsAccountRead(node.expression))
    )
      record(node);
    // Envelope delete: delete account.mempool[0] (but not delete account.pendingFrame)
    else if (
      ts.isDeleteExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
      envelopeUnsafe(node.expression.expression)
    )
      record(node);
    else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      (containsTainted(node.operand, tainted) || containsAccountRead(node.operand))
    )
      record(node);
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      mutatingMethods.has(node.expression.name.text) &&
      (containsTainted(node.expression.expression, tainted) || containsAccountRead(node.expression.expression))
    )
      record(node);
    // Envelope method call: account.mempool.push(tx) or mp.push(tx)
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      mutatingMethods.has(node.expression.name.text) &&
      envelopeUnsafe(node.expression.expression)
    )
      record(node);
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const parameterIndexes = mutatingParameterFunctions.get(node.expression.text);
      if (
        parameterIndexes &&
        [...parameterIndexes].some(index => {
          const argument = node.arguments[index];
          return argument !== undefined && (containsTainted(argument, tainted) || containsAccountRead(argument));
        })
      )
        record(node);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      staticMutators.get(node.expression.expression.text)?.has(node.expression.name.text) &&
      node.arguments[0] !== undefined &&
      (containsTainted(node.arguments[0], tainted) || containsAccountRead(node.arguments[0]))
    )
      record(node);
    // Envelope static mutator: Object.assign(account.mempool, ...) or Object.assign(mp, ...)
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      staticMutators.get(node.expression.expression.text)?.has(node.expression.name.text) &&
      node.arguments[0] !== undefined &&
      envelopeUnsafe(node.arguments[0])
    )
      record(node);
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
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
      ) {
        const name = functionName(node);
        if (name && node.body && !readers.has(name)) {
          const bodyReturnsAccount = !ts.isBlock(node.body)
            ? containsAccountRead(node.body)
            : node.body.statements.some(
                statement =>
                  ts.isReturnStatement(statement) &&
                  statement.expression !== undefined &&
                  (containsAccountRead(statement.expression) ||
                    (ts.isCallExpression(statement.expression) &&
                      ts.isIdentifier(statement.expression.expression) &&
                      readers.has(statement.expression.expression.text))),
              );
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

/** File-local helper propagation catches `mutate(state.accounts.get(id))`. */
const collectMutatingParameterFunctions = (source: ts.SourceFile): MutatingParameterFunctions => {
  const mutators = new Map<string, ReadonlySet<number>>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const name = functionName(node);
      if (name && node.body) {
        const indexes = new Set<number>();
        const parameters = node.parameters.map(parameter =>
          ts.isIdentifier(parameter.name) ? parameter.name.text : undefined,
        );
        const mutatedRoot = (target: ts.Node): void => {
          const root = rootIdentifier(target);
          if (!root || target === root) return;
          const index = parameters.indexOf(root.text);
          if (index >= 0) indexes.add(index);
        };
        const inspect = (candidate: ts.Node): void => {
          if (ts.isBinaryExpression(candidate) && assignmentOperator(candidate.operatorToken.kind))
            mutatedRoot(candidate.left);
          else if (ts.isDeleteExpression(candidate)) mutatedRoot(candidate.expression);
          else if (
            (ts.isPrefixUnaryExpression(candidate) || ts.isPostfixUnaryExpression(candidate)) &&
            (candidate.operator === ts.SyntaxKind.PlusPlusToken || candidate.operator === ts.SyntaxKind.MinusMinusToken)
          )
            mutatedRoot(candidate.operand);
          else if (
            ts.isCallExpression(candidate) &&
            ts.isPropertyAccessExpression(candidate.expression) &&
            mutatingMethods.has(candidate.expression.name.text)
          )
            mutatedRoot(candidate.expression.expression);
          else if (
            ts.isCallExpression(candidate) &&
            ts.isPropertyAccessExpression(candidate.expression) &&
            ts.isIdentifier(candidate.expression.expression) &&
            staticMutators.get(candidate.expression.expression.text)?.has(candidate.expression.name.text) &&
            candidate.arguments[0] !== undefined
          )
            mutatedRoot(candidate.arguments[0]);
          ts.forEachChild(candidate, inspect);
        };
        inspect(node.body);
        if (indexes.size > 0) mutators.set(name, indexes);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return mutators;
};

const violations: string[] = [];

const assertGateCatches = (label: string, text: string): void => {
  const source = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const readers = collectAccountReaderFunctions(source);
  const mutators = collectMutatingParameterFunctions(source);
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    )
      collectFunctionViolations(source, node, readers, mutators, found);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found.length === 0) throw new Error(`NO_READONLY_ACCOUNT_MUTATION_SELF_TEST_FAILED:${label}`);
};

assertGateCatches(
  'direct-get.ts',
  `function bad(state: any, id: string) {
  state.accounts.get(id).activeDispute.finalizeQueued = true;
}`,
);
assertGateCatches(
  'values-iteration.ts',
  `function bad(state: any) {
  for (const account of state.accounts.values()) account.mempool.push({});
}`,
);
assertGateCatches(
  'entries-iteration.ts',
  `function bad(state: any) {
  for (const [, account] of state.accounts) account.status = 'disputed';
}`,
);
assertGateCatches(
  'mutating-helper.ts',
  `function mutate(account: any) {
  account.status = 'disputed';
}
function bad(state: any, id: string) {
  mutate(state.accounts.get(id));
}`,
);
assertGateCatches(
  'object-assign.ts',
  `function bad(state: any, id: string) {
  Object.assign(state.accounts.get(id), { status: 'disputed' });
}`,
);

// --- Envelope field mutation self-tests (lever S guard) ---

assertGateCatches(
  'envelope-method-call.ts',
  `function bad(account: AccountDraftReplica) {
  account.mempool.push({});
}`,
);
assertGateCatches(
  'envelope-property-assign.ts',
  `function bad(account: AccountDraftReplica) {
  account.currentFrame.height = 5;
}`,
);
assertGateCatches(
  'envelope-alias-method.ts',
  `function bad(account: AccountDraftReplica) {
  const mp = account.mempool;
  mp.push({});
}`,
);
assertGateCatches(
  'envelope-destructure-method.ts',
  `function bad(account: AccountDraftReplica) {
  const { mempool } = account;
  mempool.push({});
}`,
);
assertGateCatches(
  'envelope-delete-element.ts',
  `function bad(account: AccountDraftReplica) {
  delete account.mempool[0];
}`,
);
assertGateCatches(
  'envelope-object-assign.ts',
  `function bad(account: AccountDraftReplica) {
  Object.assign(account.currentFrame, { height: 5 });
}`,
);

// Negative self-test: safe patterns must NOT be flagged.
const assertGateClean = (label: string, text: string): void => {
  const source = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const readers = collectAccountReaderFunctions(source);
  const mutators = collectMutatingParameterFunctions(source);
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    )
      collectFunctionViolations(source, node, readers, mutators, found);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found.length > 0) throw new Error(`READONLY_ACCOUNT_MUTATION_FALSE_POSITIVE:${label}:${found.join(',')}`);
};

// Field reassignment on draft is safe (only affects the draft shell)
assertGateClean(
  'envelope-reassign-safe.ts',
  `function ok(account: AccountDraftReplica) {
  account.mempool = [];
  account.pendingFrame = undefined;
}`,
);
// Collection mutation through draft overlay is safe (overlay-protected)
assertGateClean(
  'envelope-collection-safe.ts',
  `function ok(account: AccountDraftReplica) {
  account.state.deltas.put(1, { value: 0n });
  account.state.locks.set('lock', { id: 'lock' });
}`,
);
// Reading envelope fields is safe
assertGateClean(
  'envelope-read-safe.ts',
  `function ok(account: AccountDraftReplica) {
  const len = account.mempool.length;
  const frame = account.currentFrame;
  const height = account.currentFrame.height;
}`,
);

for (const files of sourceGlobs) {
  for await (const file of files.scan({ cwd: process.cwd(), absolute: true })) {
    if (
      file.includes('/__tests__/') ||
      file.includes('/scripts/') ||
      file.includes('/scenarios/') ||
      file.includes('/qa/')
    )
      continue;
    const source = ts.createSourceFile(
      file,
      await Bun.file(file).text(),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const accountReaderFunctions = collectAccountReaderFunctions(source);
    const mutatingParameterFunctions = collectMutatingParameterFunctions(source);
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
      )
        collectFunctionViolations(source, node, accountReaderFunctions, mutatingParameterFunctions, violations);
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
