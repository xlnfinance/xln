import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const runtimeRoot = join(import.meta.dir, '..');
const coordinatorModules = [
  'runtime.ts',
  'runtime/composition.ts',
  'api/public/runtime-public.ts',
  'api/public/public-utilities.ts',
  'runtime/loop/loop.ts',
  'storage/runtime-storage.ts',
  'storage/recovery/restore.ts',
  'runtime/state-create.ts',
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
    const browserEntrypoint = readFileSync(join(runtimeRoot, 'api/public/browser.ts'), 'utf8');
    const publicApi = readFileSync(join(runtimeRoot, 'api/public/runtime-public.ts'), 'utf8');
    expect(entrypoint).toContain("export * from './runtime/composition';");
    expect(entrypoint).toContain("export * from './api/public/runtime-public';");
    expect(entrypoint.split(/\r?\n/).length).toBeLessThanOrEqual(20);
    expect(browserEntrypoint).toContain("export * from '../../runtime';");
    expect(browserEntrypoint).toContain("export * from '../../scenarios/browser-api';");
    expect(publicApi).not.toContain("../scenarios/");
    expect(publicApi).toContain("export * from './public-utilities';");
    expect(publicApi).not.toMatch(/^\s*[A-Za-z_$][\w$]*\s+as\s+[A-Za-z_$][\w$]*\s*,?\s*$/m);
  });
});
