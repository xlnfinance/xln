import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

test('normal E2E runs cannot rewrite the tracked UX gallery', () => {
  const source = readFileSync(join(repoRoot, 'tests/utils/e2e-screenshots.ts'), 'utf8');
  expect(source).toContain("process.env['XLN_UPDATE_UX_GALLERY'] === '1'");
  expect(source).toContain('if (!UPDATE_STATIC_UX_GALLERY) return;');
});

test('UX screenshot names have one owning E2E flow', () => {
  const testsRoot = join(repoRoot, 'tests');
  const owners = new Map<string, string[]>();
  for (const file of readdirSync(testsRoot).filter((name) => /^e2e-.*\.spec\.ts$/.test(name))) {
    const source = readFileSync(join(testsRoot, file), 'utf8');
    for (const match of source.matchAll(/capture(?:Page|Locator)Screenshot\([\s\S]*?,\s*[\s\S]*?,\s*'([^']+\.png)'/g)) {
      const name = match[1];
      if (!name) continue;
      owners.set(name, [...(owners.get(name) ?? []), file]);
    }
  }
  expect([...owners.entries()].filter(([, files]) => files.length > 1)).toEqual([]);
});
