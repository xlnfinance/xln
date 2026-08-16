/** Keep the ordinary receiver path at one prepared Account transition. */
import ts from 'typescript';

const file = 'runtime/account/consensus/index.ts';
const text = ts.sys.readFile(file);
if (text === undefined) throw new Error(`ACCOUNT_SINGLE_TRANSITION_FILE_MISSING:${file}`);
const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

const findFunction = (name: string): ts.FunctionDeclaration => {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
  }
  throw new Error(`ACCOUNT_SINGLE_TRANSITION_FUNCTION_MISSING:${name}`);
};

const callsNamed = (root: ts.Node, name: string): ts.CallExpression[] => {
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === name
    ) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
};

const commit = findFunction('commitIncomingFrameOnRealState');
if (callsNamed(commit, 'reexecuteIncomingFrame').length !== 0) {
  throw new Error('ACCOUNT_RECEIVER_ORDINARY_REEXECUTION_FORBIDDEN');
}

const validation = findFunction('validateIncomingFrameOnDraft');
if (callsNamed(validation, 'commitAccountTransition').length !== 1) {
  throw new Error('ACCOUNT_RECEIVER_PREPARED_TRANSITION_REQUIRED');
}

const collisionReplayCalls = callsNamed(source, 'reexecuteIncomingFrame');
if (collisionReplayCalls.length !== 1) {
  throw new Error(`ACCOUNT_RECEIVER_COLLISION_REPLAY_COUNT:${collisionReplayCalls.length}`);
}

const requireSource = (path: string): ts.SourceFile => {
  const contents = ts.sys.readFile(path);
  if (contents === undefined) throw new Error(`ACCOUNT_SINGLE_TRANSITION_FILE_MISSING:${path}`);
  return ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);
};

const findFunctionIn = (root: ts.SourceFile, name: string): ts.Node => {
  for (const statement of root.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    if (
      ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some((declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === name)
    ) return statement;
  }
  throw new Error(`ACCOUNT_SINGLE_TRANSITION_FUNCTION_MISSING:${root.fileName}:${name}`);
};

// A committed multi-transaction Account frame owns one overlay. Reintroducing
// per-transaction preparation is correct bytewise but turns settlement cost
// back into O(frame transactions * Patricia preparation).
const ackSource = requireSource('runtime/account/consensus/incoming/ack-commit.ts');
const pendingCommit = findFunctionIn(ackSource, 'applyPendingFrameTransactions');
if (callsNamed(pendingCommit, 'commitAccountFrameTransition').length !== 1) {
  throw new Error('ACCOUNT_PROPOSER_FRAME_TRANSITION_COUNT_INVALID');
}
if (callsNamed(pendingCommit, 'applyAccountTxToMutableReplica').length !== 0) {
  throw new Error('ACCOUNT_PROPOSER_PER_TX_TRANSITION_FORBIDDEN');
}

const transitionSource = requireSource('runtime/account/consensus/frame/commit-transition.ts');
const frameTransition = transitionSource.statements.find((statement) =>
  ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some((declaration) =>
    ts.isIdentifier(declaration.name) && declaration.name.text === 'commitAccountFrameTransition'));
if (!frameTransition || callsNamed(frameTransition, 'commitAccountTransition').length !== 1) {
  throw new Error('ACCOUNT_FRAME_OVERLAY_COMMIT_COUNT_INVALID');
}

// Object.assign installs the prepared replica shell. Account transaction
// handlers may replace fields, including `state`, but must not delete a
// top-level replica field: assignment cannot remove a property from the live
// shell. Nested state deletion is safe because the whole state object changes.
for (const handlerFile of ts.sys.readDirectory('runtime/account/tx', ['.ts'])) {
  const handlerText = ts.sys.readFile(handlerFile);
  if (handlerText === undefined) continue;
  const handler = ts.createSourceFile(handlerFile, handlerText, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (
      ts.isDeleteExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && ['account', 'machine', 'draft'].includes(node.expression.expression.text)
    ) {
      const position = handler.getLineAndCharacterOfPosition(node.getStart(handler));
      throw new Error(
        `ACCOUNT_TX_TOP_LEVEL_DELETE_FORBIDDEN:${handlerFile}:${position.line + 1}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(handler);
}

console.log('ACCOUNT_FRAME_SINGLE_TRANSITION_OK');
