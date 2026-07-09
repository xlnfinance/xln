import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'bun:test';

const repoRoot = process.cwd();

const collectRuntimeSourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const relPath = relative(repoRoot, fullPath);

    if (
      relPath.includes('/__tests__/') ||
      relPath.includes('/scenarios/') ||
      relPath.includes('/scripts/')
    ) {
      return [];
    }

    const stats = statSync(fullPath);
    if (stats.isDirectory()) return collectRuntimeSourceFiles(fullPath);
    return fullPath.endsWith('.ts') ? [fullPath] : [];
  });

const rawEntityInputSendAllowedFiles = new Set([
  'runtime/networking/p2p.ts',
  'runtime/networking/ws-client.ts',
]);

const deliveryOutcomeComparisonAllowedFiles = new Set([
  'runtime/delivery-result.ts',
]);

test('raw entity input websocket send stays behind the P2P delivery adapter', () => {
  const offenders = collectRuntimeSourceFiles(join(repoRoot, 'runtime'))
    .map((file) => {
      const relPath = relative(repoRoot, file);
      if (rawEntityInputSendAllowedFiles.has(relPath)) return null;

      const source = readFileSync(file, 'utf8');
      return /\bsendEntityInputRaw\s*\(/.test(source) || /['"]sendEntityInputRaw['"]/.test(source)
        ? relPath
        : null;
    })
    .filter((relPath): relPath is string => relPath !== null);

  expect(offenders).toEqual([]);
});

test('delivery outcome decisions stay behind shared helpers', () => {
  const rawDeliveryOutcomeComparison =
    /\.outcome\s*(?:===|!==|==|!=)\s*['"](?:delivered|queued|deferred|failed)['"]|['"](?:delivered|queued|deferred|failed)['"]\s*(?:===|!==|==|!=)[^\n]*\.outcome/;
  const offenders = collectRuntimeSourceFiles(join(repoRoot, 'runtime'))
    .map((file) => {
      const relPath = relative(repoRoot, file);
      if (deliveryOutcomeComparisonAllowedFiles.has(relPath)) return null;

      const source = readFileSync(file, 'utf8');
      return rawDeliveryOutcomeComparison.test(source) ? relPath : null;
    })
    .filter((relPath): relPath is string => relPath !== null);

  expect(offenders).toEqual([]);
});
