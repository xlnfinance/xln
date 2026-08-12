import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'frontend/src/lib/stores/runtimeViewStore.ts'),
  'utf8',
);

test('runtime adapter changes discard the previous runtime height target', () => {
  const resetStart = source.indexOf('export const resetRuntimeView = (): void => {');
  const resetEnd = source.indexOf('\n};', resetStart);
  expect(resetStart).toBeGreaterThanOrEqual(0);
  expect(source.slice(resetStart, resetEnd)).toContain('pendingHeightRefresh = 0;');
});
