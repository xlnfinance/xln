import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const productionOnly = process.argv.includes('--production-only');
const allowed = new Set([
  'runtime/runtime/registration/entity-creation/index.ts',
  // Decoder/admission fixtures intentionally construct malformed payloads.
  'runtime/__tests__/api/runtime-adapter/radapter-part-2.test.ts',
  // These assert malformed retired-shape payloads are rejected at admission;
  // routing them through the valid constructor would destroy the test subject.
  'runtime/__tests__/api/runtime-adapter/radapter-part-1.test.ts',
  'runtime/__tests__/runtime/ingress/runtime-input-queue.test.ts',
  'runtime/__tests__/testing/audit/audit-failfast-regressions-part-1.test.ts',
]);

const files = (directory: string): string[] => readdirSync(directory).flatMap(name => {
  const path = join(directory, name);
  if (name === 'node_modules' || name === '.git') return [];
  return statSync(path).isDirectory() ? files(path) : /\.(?:ts|tsx|svelte)$/.test(path) ? [path] : [];
});

const violations: string[] = [];
const firstPartyRoots = ['runtime', 'frontend/src', 'ui/src', 'cli', 'native'];
for (const path of firstPartyRoots.flatMap(directory => files(join(root, directory)))) {
  if (productionOnly && relative(root, path).startsWith('runtime/__tests__/')) continue;
  const source = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const type = node.properties.find((property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && property.name.getText(file).replaceAll(/["']/g, '') === 'type');
      const initializer = type && ts.isAsExpression(type.initializer)
        ? type.initializer.expression
        : type?.initializer;
      if (
        type && initializer && ts.isStringLiteralLike(initializer) && initializer.text === 'importReplica' &&
        !allowed.has(relative(root, path))
      ) {
        const line = file.getLineAndCharacterOfPosition(type.getStart(file)).line + 1;
        violations.push(`${relative(root, path)}:${line}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

if (violations.length > 0) {
  throw new Error(`RAW_ENTITY_IMPORT_BOUNDARY_VIOLATION:\n${violations.join('\n')}`);
}
console.log(`Entity import boundary: canonical scope=${productionOnly ? 'production' : 'all'} (${allowed.size} explicit sites)`);
