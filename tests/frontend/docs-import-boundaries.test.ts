import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const DOCS_APP = resolve(ROOT, 'frontend/apps/docs');

const sourceFiles = (root: string): readonly string[] => readdirSync(root).flatMap(name => {
  const path = join(root, name);
  if (statSync(path).isDirectory()) return sourceFiles(path);
  return /\.(?:ts|tsx)$/.test(path) ? [path] : [];
});
const imports = (source: string): readonly string[] => [...source.matchAll(
  /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g,
)].map(match => match[1]!);

describe('React docs import boundaries', () => {
  test('does not import wallet, runtime, native, ops, or retired route implementations', () => {
    const violations = sourceFiles(DOCS_APP).flatMap(file => imports(readFileSync(file, 'utf8'))
      .filter(specifier => /(?:capacitor|electron|brainvault|runtime|vault|commandJournal|apps\/(?:wallet|site|ops)|src\/routes)/i.test(specifier))
      .map(specifier => `${relative(ROOT, file)} -> ${specifier}`));
    expect(violations).toEqual([]);
  });

  test('wallet guide consumes the shared validated catalog parser', () => {
    const source = readFileSync(resolve(ROOT, 'frontend/src/lib/ai/xln-guide-context.ts'), 'utf8');
    expect(source).toContain('parseDocsCatalogManifest(await manifestResponse.json())');
    expect(source).not.toContain('as DocsManifest');
    expect(source).not.toContain('manifest.items ?? []');
  });

  test('the shared catalog contract remains framework-neutral', () => {
    const source = readFileSync(resolve(ROOT, 'frontend/packages/client-core/docs-catalog-contract.js'), 'utf8');
    expect(imports(source)).toEqual([]);
    expect(source).not.toMatch(/react|wallet|runtime/i);
  });
});
