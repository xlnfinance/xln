import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { findValueImportComponents, isValueModuleReference } from './import-cycle-analysis';

const RUNTIME_ROOT = path.resolve('runtime');
const EXCLUDED_PATH = /\/(?:__tests__|qa|scenarios|scripts)\//;

const ROOT_ENTRYPOINTS = new Set(['runtime/runtime.ts']);
const MAX_VALUE_IMPORT_SCC_SIZE = 13;

// Root files obscure ownership and attract cross-layer imports. This is
// migration debt, not a stable public layout; only runtime.ts is the intended
// root entrypoint.
const ROOT_FILE_DEBT = new Set([
  'runtime/constants.ts',
  'runtime/ids.ts',
  'runtime/state-helpers.ts',
  'runtime/types.ts',
  'runtime/utils.ts',
  'runtime/validation-utils.ts',
  'runtime/xln-api-guard.ts',
  'runtime/xln-api.ts',
]);

// These directions violate the Runtime → Entity → Account cascade or make a
// lower deterministic layer depend on external/operational infrastructure.
// Existing counts are migration debt: every increase and every newly
// introduced direction fails, while completed cleanup must remove its entry.
const REVERSE_DEPENDENCY_DEBT: Readonly<Record<string, number>> = {
  'account->entity': 2,
  'account->storage': 1,
  'entity->jadapter': 5,
  'entity->networking': 6,
  'entity->runtime': 11,
  'entity->storage': 3,
  'protocol->account': 5,
  'protocol->entity': 2,
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

const packageOwner = (file: string): string => {
  const relative = path.relative(RUNTIME_ROOT, file);
  const parts = relative.split(path.sep);
  return parts.length === 1 ? '(root)' : (parts[0] ?? '(root)');
};

const resolveRuntimeFile = (specifier: string, importer: string): string | null => {
  if (!specifier.startsWith('.')) return null;
  const resolved = ts.resolveModuleName(
    specifier,
    importer,
    {
      allowImportingTsExtensions: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  if (!resolved) return null;
  const absolute = path.resolve(resolved);
  if (absolute !== RUNTIME_ROOT && !absolute.startsWith(`${RUNTIME_ROOT}${path.sep}`)) return null;
  return path.relative(process.cwd(), absolute);
};

const literalModuleSpecifier = (node: ts.Node): string | null => {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  const firstArgument = ts.isCallExpression(node) ? node.arguments[0] : undefined;
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    firstArgument &&
    ts.isStringLiteral(firstArgument) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
  ) {
    return firstArgument.text;
  }
  return null;
};

const observed = new Map<string, Array<{ file: string; line: number; specifier: string }>>();
const files = collectFiles('runtime').sort();
const fileSet = new Set(files);
const valueGraph = new Map<string, Set<string>>(files.map(file => [file, new Set()]));
const rootFiles = files.filter(file => packageOwner(path.resolve(file)) === '(root)');

for (const file of files) {
  const from = packageOwner(path.resolve(file));
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    const specifier = literalModuleSpecifier(node);
    if (specifier) {
      const targetFile = resolveRuntimeFile(specifier, path.resolve(file));
      if (targetFile && fileSet.has(targetFile) && isValueModuleReference(node)) {
        valueGraph.get(file)?.add(targetFile);
      }
      const to = targetFile ? packageOwner(path.resolve(targetFile)) : null;
      const key = to ? `${from}->${to}` : '';
      if (key && Object.hasOwn(REVERSE_DEPENDENCY_DEBT, key)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const occurrences = observed.get(key) ?? [];
        occurrences.push({ file, line, specifier });
        observed.set(key, occurrences);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const errors: string[] = [];
for (const file of rootFiles) {
  if (!ROOT_ENTRYPOINTS.has(file) && !ROOT_FILE_DEBT.has(file)) {
    errors.push(`NEW_RUNTIME_ROOT_FILE ${file}`);
  }
}
for (const file of ROOT_ENTRYPOINTS) {
  if (!rootFiles.includes(file)) errors.push(`RUNTIME_ROOT_ENTRYPOINT_MISSING ${file}`);
}
for (const file of ROOT_FILE_DEBT) {
  if (!rootFiles.includes(file)) errors.push(`STALE_RUNTIME_ROOT_FILE_ALLOWANCE ${file}`);
}
for (const [key, allowance] of Object.entries(REVERSE_DEPENDENCY_DEBT)) {
  const occurrences = observed.get(key) ?? [];
  if (occurrences.length === 0) {
    errors.push(`STALE_REVERSE_DEPENDENCY_ALLOWANCE ${key}`);
    continue;
  }
  if (occurrences.length <= allowance) continue;
  const additions = occurrences
    .slice(allowance)
    .map(item => `${item.file}:${item.line}:${item.specifier}`)
    .join(',');
  errors.push(`REVERSE_DEPENDENCY_GREW ${key} ${occurrences.length} > ${allowance} ${additions}`);
}
const valueComponents = findValueImportComponents(valueGraph);
const largestValueComponent = valueComponents[0] ?? [];
if (largestValueComponent.length > MAX_VALUE_IMPORT_SCC_SIZE) {
  errors.push(
    `VALUE_IMPORT_SCC_GREW ${largestValueComponent.length} > ${MAX_VALUE_IMPORT_SCC_SIZE} ` +
      largestValueComponent.join(','),
  );
}
if (largestValueComponent.length < MAX_VALUE_IMPORT_SCC_SIZE) {
  errors.push(
    `STALE_VALUE_IMPORT_SCC_ALLOWANCE ${largestValueComponent.length} < ${MAX_VALUE_IMPORT_SCC_SIZE} ` +
      largestValueComponent.join(','),
  );
}

if (errors.length > 0) {
  console.error('Runtime dependency direction invariant failed:\n');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const debt = [...observed.values()].reduce((sum, occurrences) => sum + occurrences.length, 0);
console.log(
  `RUNTIME_DEPENDENCIES_OK files=${files.length} reverseImports=${debt}/` +
    `${Object.values(REVERSE_DEPENDENCY_DEBT).reduce((sum, count) => sum + count, 0)} ` +
    `rootDebt=${ROOT_FILE_DEBT.size} maxValueScc=${largestValueComponent.length}`,
);
