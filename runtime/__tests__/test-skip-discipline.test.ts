import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SCAN_ROOTS = ['tests', 'runtime/__tests__', 'jurisdictions/test'];
const TEST_EXTENSIONS = new Set(['.ts', '.js', '.cjs', '.mjs']);
const SKIP_PATTERN = /\b(?:describe|test|it)\.skip\s*\(|\bxdescribe\s*\(|\bxit\s*\(/g;
const ALLOW_MARKER = 'XLN_ALLOW_SKIP';

const listTestFiles = async (dir: string, out: string[] = []): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await listTestFiles(path, out);
    } else if (TEST_EXTENSIONS.has(extname(entry.name))) {
      out.push(path);
    }
  }
  return out;
};

describe('test skip discipline', () => {
  test('does not allow silent skipped tests', async () => {
    const self = join(import.meta.dir, 'test-skip-discipline.test.ts');
    const files = (
      await Promise.all(SCAN_ROOTS.map((root) => listTestFiles(join(REPO_ROOT, root))))
    ).flat().filter((path) => path !== self);
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const skipCount = [...source.matchAll(SKIP_PATTERN)].length;
      if (skipCount === 0) continue;
      const allowCount = source.split(ALLOW_MARKER).length - 1;
      if (allowCount < skipCount) {
        violations.push(`${relative(REPO_ROOT, file)} has ${skipCount} unapproved skipped test(s)`);
      }
    }

    expect(violations).toEqual([]);
  });
});
