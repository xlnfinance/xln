import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Both wallets are first-class faces over the canonical runtime. A face may
 * depend on the engine; it must never depend on the other face, because that
 * makes the two wallets one application that cannot be built, tested or
 * reviewed apart.
 *
 * check-runtime-dependencies.ts owns direction inside core/ and follows only
 * relative specifiers. Wallet coupling is written as path aliases
 * (`@xln/frontend/*`, `$lib/*`) across .ts, .tsx and .svelte, so it needs its
 * own resolution and lives here rather than distorting that gate.
 */

const WALLET_ROOTS: Readonly<Record<string, readonly string[]>> = {
  ui: ['ui/src', 'ui/tests', 'ui/tools'],
  frontend: ['frontend/src', 'frontend/tests', 'frontend/scripts'],
};

const SKIPPED_DIRECTORY = /(?:^|\/)(?:node_modules|\.svelte-kit|build|dist|static|android|ios)(?:\/|$)/;

// Permanent bans. These edges are at zero, so the gate keeps rejecting their
// reintroduction; they are not zero-sized debt allowances.
const FORBIDDEN_EDGES = new Set(['frontend->ui', 'frontend->core-tests']);

// Shrink-only migration debt. Lower each number as the edge shrinks, never
// raise it; the gate also rejects a stale allowance, so the count stays exact.
//
// ui->frontend: the React wallet still consumes the Svelte wallet's library.
// Those modules are presentation logic that belongs beside the engine.
// ui->core-tests: wallet tests reach into the engine's own fixtures, which
// makes core/__tests__ a published surface. A wallet test owns its fixtures or
// shares them through a real module.
//
// At zero, move the edge into FORBIDDEN_EDGES above.
const EDGE_DEBT: Readonly<Record<string, number>> = {
  'ui->frontend': 90,
  'ui->core-tests': 3,
};

type Edge = { file: string; line: number; specifier: string };

const collectFiles = (directory: string): string[] => {
  if (!fs.existsSync(directory) || SKIPPED_DIRECTORY.test(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(target);
    if (!entry.isFile() || target.endsWith('.d.ts')) return [];
    return /\.(?:ts|tsx|svelte)$/.test(target) ? [target] : [];
  });
};

/** A .svelte file carries its module graph in <script> blocks; the TypeScript
 * parser reads those directly, so no import is matched by regular expression. */
const parsedModules = (file: string): Array<{ source: ts.SourceFile; lineOffset: number }> => {
  const text = fs.readFileSync(file, 'utf8');
  if (!file.endsWith('.svelte')) {
    return [
      { source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), lineOffset: 0 },
    ];
  }
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => ({
    source: ts.createSourceFile(file, match[1] ?? '', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    lineOffset: text.slice(0, match.index ?? 0).split('\n').length - 1,
  }));
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
    firstArgument &&
    ts.isStringLiteral(firstArgument) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    return firstArgument.text;
  }
  return null;
};

/** The owner a specifier reaches, by alias or by resolved path. `null` means
 * the engine, a package, or the importer's own wallet: all permitted. */
const targetOwner = (specifier: string, importer: string): string | null => {
  const stripped = specifier.replace(/\?.*$/, '');
  if (stripped.startsWith('@xln/frontend/') || stripped.startsWith('$lib/')) return 'frontend';
  if (stripped.startsWith('@xln/ui/')) return 'ui';
  if (stripped.startsWith('@xln/core/__tests__')) return 'core-tests';
  if (!stripped.startsWith('.')) return null;
  const resolved = path.relative(process.cwd(), path.resolve(path.dirname(importer), stripped));
  if (resolved.startsWith('core/__tests__')) return 'core-tests';
  for (const [owner, roots] of Object.entries(WALLET_ROOTS)) {
    if (roots.some(root => resolved === root || resolved.startsWith(`${root}/`))) return owner;
  }
  return null;
};

const observed = new Map<string, Edge[]>();
let scanned = 0;

for (const [owner, roots] of Object.entries(WALLET_ROOTS)) {
  for (const file of roots.flatMap(collectFiles).sort()) {
    scanned += 1;
    for (const { source, lineOffset } of parsedModules(file)) {
      const visit = (node: ts.Node): void => {
        const specifier = literalModuleSpecifier(node);
        const to = specifier ? targetOwner(specifier, file) : null;
        if (specifier && to && to !== owner) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 + lineOffset;
          const key = `${owner}->${to}`;
          observed.set(key, [...(observed.get(key) ?? []), { file, line, specifier }]);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
}

const describe = (edges: readonly Edge[]): string =>
  edges.map(edge => `${edge.file}:${edge.line}:${edge.specifier}`).join(',');

const errors: string[] = [];
for (const key of FORBIDDEN_EDGES) {
  const edges = observed.get(key) ?? [];
  if (edges.length > 0) errors.push(`FORBIDDEN_WALLET_DEPENDENCY ${key} ${describe(edges)}`);
}
for (const [key, allowance] of Object.entries(EDGE_DEBT)) {
  const edges = observed.get(key) ?? [];
  if (edges.length > allowance) {
    // The tail past the allowance, in file order: the overflow, not necessarily
    // the import just added. Compare against your own diff.
    errors.push(
      `WALLET_DEPENDENCY_GREW ${key} ${edges.length} > ${allowance} overflow=${describe(edges.slice(allowance))}`,
    );
    continue;
  }
  if (edges.length < allowance) {
    errors.push(`STALE_WALLET_DEPENDENCY_ALLOWANCE ${key} ${edges.length} < ${allowance}`);
  }
}
for (const key of observed.keys()) {
  if (!FORBIDDEN_EDGES.has(key) && !Object.hasOwn(EDGE_DEBT, key)) {
    errors.push(`UNDECLARED_WALLET_DEPENDENCY ${key} ${describe(observed.get(key) ?? [])}`);
  }
}

if (errors.length > 0) {
  console.error('Wallet boundary invariant failed:\n');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const total = [...observed.values()].reduce((sum, edges) => sum + edges.length, 0);
console.log(
  `WALLET_BOUNDARIES_OK files=${scanned} forbiddenEdges=${FORBIDDEN_EDGES.size} ` +
    `crossImports=${total}/${Object.values(EDGE_DEBT).reduce((sum, count) => sum + count, 0)}`,
);
