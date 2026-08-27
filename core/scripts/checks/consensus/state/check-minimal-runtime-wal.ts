import ts from 'typescript';

const configPath = ts.findConfigFile('.', ts.sys.fileExists, 'tsconfig.runtime.json');
if (!configPath) throw new Error('MINIMAL_RUNTIME_WAL_TSCONFIG_MISSING');

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, '.', undefined, configPath);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const violations: string[] = [];
const forbiddenFrameFields = new Set([
  'activityLogs',
  'entityContexts',
  'historyRecords',
  'overlayRecords',
  'pendingRuntimeInput',
  'runtimeMachine',
  'runtimeOutputs',
]);
const forbiddenHotCalls = new Set([
  'buildDurableRuntimeMachineSnapshot',
  'buildReplayVerifiableRuntimeMachineSnapshot',
  'structuredClone',
]);

const report = (source: ts.SourceFile, node: ts.Node, code: string): void => {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  violations.push(`${source.fileName}:${line + 1}:${code}`);
};

const propertyName = (name: ts.PropertyName | undefined): string | undefined => {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
};

for (const source of program.getSourceFiles()) {
  const normalized = source.fileName.replaceAll('\\', '/');
  if (normalized.endsWith('/core/storage/types.ts')) {
    const visitType = (node: ts.Node): void => {
      const isRuntimeFrame =
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        node.name.text === 'RuntimeFrame';
      if (isRuntimeFrame) {
        const members = ts.isInterfaceDeclaration(node)
          ? node.members
          : ts.isTypeLiteralNode(node.type)
            ? node.type.members
            : [];
        for (const member of members) {
          const name = propertyName(member.name);
          if (name && forbiddenFrameFields.has(name)) report(source, member, `forbidden-frame-field:${name}`);
        }
      }
      ts.forEachChild(node, visitType);
    };
    visitType(source);
  }
  if (normalized.endsWith('/core/storage/index.ts')) {
    const visitHotPath = (node: ts.Node, insideBuilder = false): void => {
      const entersBuilder =
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'buildStorageRuntimeFrame';
      const active = insideBuilder || entersBuilder;
      if (active && ts.isPropertyAssignment(node)) {
        const name = propertyName(node.name);
        if (name && forbiddenFrameFields.has(name)) report(source, node, `forbidden-frame-write:${name}`);
      }
      if (active && ts.isShorthandPropertyAssignment(node) && forbiddenFrameFields.has(node.name.text)) {
        report(source, node, `forbidden-frame-write:${node.name.text}`);
      }
      if (active && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (forbiddenHotCalls.has(node.expression.text)) report(source, node, `forbidden-hot-call:${node.expression.text}`);
      }
      ts.forEachChild(node, child => visitHotPath(child, active));
    };
    visitHotPath(source);
  }
}

if (violations.length > 0) {
  throw new Error(`MINIMAL_RUNTIME_WAL_VIOLATION:${violations.length}\n${violations.sort().join('\n')}`);
}

console.log('MINIMAL_RUNTIME_WAL_OK');
