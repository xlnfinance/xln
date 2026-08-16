import ts from 'typescript';

const configPath = ts.findConfigFile('.', ts.sys.fileExists, 'tsconfig.runtime.json');
if (!configPath) throw new Error('NO_HOT_SCANS_TSCONFIG_MISSING');

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

const ACCOUNT_MAP_NAMES = new Set([
  'PersistentEntityAccountMap',
  'EntityAccountCandidateMap',
  'EntityAccountMap',
]);
const ITERATOR_METHODS = new Set(['entries', 'values', 'keys', 'forEach', 'find', 'filter']);

const OWNING_HOT_PATHS = [
  '/runtime/entity/tx/j-events.ts',
  '/runtime/runtime/delivery/identity.ts',
  '/runtime/runtime/reliable/reliable-authority.ts',
  '/runtime/entity/tx/handlers/account/orderbook/same/results.ts',
];

const isOwningHotPath = (path: string): boolean =>
  OWNING_HOT_PATHS.some(suffix => path.endsWith(suffix));

const typeName = (type: ts.Type): string | undefined =>
  type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();

const isAccountMachineMap = (type: ts.Type, seen = new Set<ts.Type>()): boolean => {
  if (seen.has(type)) return false;
  seen.add(type);
  const name = typeName(type);
  if (name && ACCOUNT_MAP_NAMES.has(name)) return true;
  if (type.isUnionOrIntersection()) {
    return type.types.some(member => isAccountMachineMap(member, seen));
  }
  return (type as ts.TypeReference).typeArguments?.some(argument =>
    isAccountMachineMap(argument, seen),
  ) ?? false;
};

const isEntityReplicaMap = (type: ts.Type): boolean => {
  const name = typeName(type);
  if (name !== 'Map' && name !== 'ReadonlyMap') return false;
  return ((type as ts.TypeReference).typeArguments ?? []).some(argument =>
    typeName(argument) === 'EntityReplica',
  );
};

const flag = (source: ts.SourceFile, node: ts.Node, label: string): void => {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  violations.push(`${source.fileName}:${position.line + 1}:${label}`);
};

const sourceFiles = program.getSourceFiles().filter(source => {
  const path = source.fileName.replaceAll('\\', '/');
  return path.includes('/runtime/') && isOwningHotPath(path);
});

const ACCOUNT_WORK_INDEX_PATH = '/runtime/entity/consensus/account/work-index.ts';

for (const source of sourceFiles) {
  const visit = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && isAccountMachineMap(checker.getTypeAtLocation(node.expression))) {
      flag(source, node, 'hot-account-map-for-of');
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (ITERATOR_METHODS.has(method) && isAccountMachineMap(checker.getTypeAtLocation(receiver))) {
        flag(source, node, `hot-account-map-${method}`);
      }
    }
    if (
      (ts.isSpreadElement(node) || ts.isArrayLiteralExpression(node)) &&
      ts.isSpreadElement(node)
    ) {
      if (isAccountMachineMap(checker.getTypeAtLocation(node.expression))) {
        flag(source, node, 'hot-account-map-spread');
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'from' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Array' &&
      node.arguments[0] &&
      isAccountMachineMap(checker.getTypeAtLocation(node.arguments[0]))
    ) {
      flag(source, node, 'hot-account-map-array-from');
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'find' &&
      isEntityReplicaMap(checker.getTypeAtLocation(node.expression.expression))
    ) {
      flag(source, node, 'hot-ereplicas-find');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

// A scheduler index must be derived from the persistent Account map. Hidden
// Symbol/Object.defineProperty caches are not encoded in WAL or snapshots and
// previously made live execution disagree with cold replay on runnable work.
for (const source of program.getSourceFiles()) {
  const path = source.fileName.replaceAll('\\', '/');
  if (!path.endsWith(ACCOUNT_WORK_INDEX_PATH)) continue;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'Symbol') ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'Object' &&
          node.expression.name.text === 'defineProperty'))
    ) {
      flag(source, node, 'hidden-account-work-cache');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (violations.length > 0) {
  throw new Error(`HOT_FULL_MACHINE_SCAN:${violations.length}\n${violations.sort().join('\n')}`);
}

console.log('NO_HOT_FULL_MACHINE_SCANS_OK');
