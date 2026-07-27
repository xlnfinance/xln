import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const runtimeRoot = join(import.meta.dir, '..');
const coordinatorModules = [
  'runtime.ts',
  'runtime-core.ts',
  'runtime-public-api.ts',
  'public-utilities.ts',
  'engine/loop.ts',
  'persistence/runtime-storage.ts',
  'recovery/restore.ts',
  'state/create.ts',
] as const;

describe('runtime coordinator module boundaries', () => {
  test('keeps every coordinator module below 3000 lines', () => {
    for (const relativePath of coordinatorModules) {
      const source = readFileSync(join(runtimeRoot, relativePath), 'utf8');
      const lineCount = source.split(/\r?\n/).length;
      expect(lineCount, `${relativePath} has ${lineCount} lines`).toBeLessThanOrEqual(3_000);
    }
  });

  test('keeps the public entrypoint narrow and the utility exports centralized', () => {
    const entrypoint = readFileSync(join(runtimeRoot, 'runtime.ts'), 'utf8');
    const publicApi = readFileSync(join(runtimeRoot, 'runtime-public-api.ts'), 'utf8');
    expect(entrypoint).toContain("export * from './runtime-core';");
    expect(entrypoint).toContain("export * from './runtime-public-api';");
    expect(entrypoint.split(/\r?\n/).length).toBeLessThanOrEqual(20);
    expect(publicApi).toContain("export * from './public-utilities';");
    expect(publicApi).not.toMatch(/^\s*[A-Za-z_$][\w$]*\s+as\s+[A-Za-z_$][\w$]*\s*,?\s*$/m);
  });
});
