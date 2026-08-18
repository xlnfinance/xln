import ts from 'typescript';

import { collectSealValueGraphViolations } from './check-no-machine-seal-value';

const configPath = ts.findConfigFile('.', ts.sys.fileExists, 'tsconfig.runtime.json');
if (!configPath) throw new Error('NO_MACHINE_CLONES_TSCONFIG_MISSING');

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
}
const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  '.',
  undefined,
  configPath,
);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const violations: string[] = [];

const forbiddenHelpers = new Set([
  'cloneEntityReplica',
  'cloneEntityState',
  'cloneRuntimeReplica',
  'cloneRuntimeState',
  'snapshotEntityAccountMap',
  'snapshotEntityOrderbookCandidate',
  'cloneAccountReplica',
  'cloneAccountState',
  'cloneEntityStateWithPolicy',
  'cloneAccountReplicaWithPolicy',
]);
const structuredCloneHelpers = new Set(['structuredClone', 'structuredCloneOrThrow']);
const forbiddenTypeNames = new Set([
  'RuntimeReplica',
  'RuntimeState',
  'EntityReplica',
  'EntityState',
  'BookState',
  'OrderbookExtState',
  'EntityCandidateMap',
  'AccountReplica',
  'AccountState',
]);
const persistentCollectionTypeNames = new Set([
  'PersistentRadixValueMap',
  'PersistentAccountStateMap',
  'PersistentEntityAccountMap',
  'EntityAccountCandidateMap',
  'PersistentEntityCollectionMap',
  'EntityCollectionCandidateMap',
  'BookBranchMap',
]);

const typeContainsForbiddenMachine = (
  type: ts.Type,
  seen = new Set<ts.Type>(),
): boolean => {
  if (seen.has(type)) return false;
  seen.add(type);
  const names = [type.aliasSymbol?.getName(), type.getSymbol()?.getName()];
  if (names.some(name => name !== undefined && forbiddenTypeNames.has(name))) {
    return true;
  }
  if (type.isUnionOrIntersection()) {
    return type.types.some(member => typeContainsForbiddenMachine(member, seen));
  }
  const reference = type as ts.TypeReference;
  return (reference.typeArguments ?? [])
    .some(argument => typeContainsForbiddenMachine(argument, seen));
};

const typeContainsPersistentCollection = (
  type: ts.Type,
  seen = new Set<ts.Type>(),
): boolean => {
  if (seen.has(type)) return false;
  seen.add(type);
  const names = [type.aliasSymbol?.getName(), type.getSymbol()?.getName()];
  if (names.some(name => name !== undefined && persistentCollectionTypeNames.has(name))) {
    return true;
  }
  if (type.isUnionOrIntersection()) {
    return type.types.some(member => typeContainsPersistentCollection(member, seen));
  }
  const reference = type as ts.TypeReference;
  return (reference.typeArguments ?? [])
    .some(argument => typeContainsPersistentCollection(argument, seen));
};

const rootExpression = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const sourceFiles = program.getSourceFiles().filter(source => {
  const path = source.fileName.replaceAll('\\', '/');
  return path.includes('/core/') &&
    !path.includes('/core/__tests__/') &&
    !path.includes('/core/scenarios/') &&
    !path.includes('/core/qa/') &&
    !path.endsWith('/check-no-machine-clones.ts') &&
    !path.endsWith('/check-no-machine-seal-value.ts');
});

for (const source of sourceFiles) {
  const visit = (node: ts.Node): void => {
    if (
      ts.isClassDeclaration(node)
      && node.heritageClauses?.some(clause =>
        clause.token === ts.SyntaxKind.ExtendsKeyword
        && clause.types.some(type => type.expression.getText(source) === 'Map'))
    ) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${source.fileName}:${position.line + 1}:extends Map`);
    }
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node))
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'Proxy'
    ) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${source.fileName}:${position.line + 1}:Proxy`);
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
      && ts.isIdentifier(node.right)
      && node.right.text === 'Map'
      && typeContainsPersistentCollection(checker.getTypeAtLocation(node.left))
    ) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${source.fileName}:${position.line + 1}:persistent collection instanceof Map`);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const helperName = ts.isIdentifier(callee) ? callee.text : undefined;
      if (helperName && forbiddenHelpers.has(helperName)) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${source.fileName}:${position.line + 1}:${helperName}`);
      }
      if (helperName && structuredCloneHelpers.has(helperName) && node.arguments[0]) {
        const argument = node.arguments[0];
        const argumentType = checker.getTypeAtLocation(argument);
        const rootType = checker.getTypeAtLocation(rootExpression(argument));
        if (
          typeContainsForbiddenMachine(argumentType) ||
          typeContainsForbiddenMachine(rootType)
        ) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(`${source.fileName}:${position.line + 1}:structuredClone`);
        }
      }
    }
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'Map'
      && node.arguments?.[0]
    ) {
      const argument = node.arguments[0];
      if (typeContainsForbiddenMachine(checker.getTypeAtLocation(argument))) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${source.fileName}:${position.line + 1}:new Map(machine)`);
      }
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
      && node.name
      && /clone/i.test(node.name.getText(source))
    ) {
      const signature = checker.getSignatureFromDeclaration(node);
      if (
        signature
        && (
          typeContainsForbiddenMachine(checker.getReturnTypeOfSignature(signature))
          || node.parameters.some(parameter =>
            typeContainsForbiddenMachine(checker.getTypeAtLocation(parameter)))
        )
      ) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${source.fileName}:${position.line + 1}:machine clone declaration`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

violations.push(
  ...collectSealValueGraphViolations(sourceFiles, checker, typeContainsForbiddenMachine),
);

if (violations.length > 0) {
  throw new Error(
    `MACHINE_CLONE_FORBIDDEN:${violations.length}\n${violations.sort().join('\n')}`,
  );
}

console.log('NO_MACHINE_CLONES_OK');
