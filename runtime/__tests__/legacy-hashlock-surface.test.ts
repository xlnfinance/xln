import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildRuntimeActivityEvents } from '../api/public/activity-history';
import { validateEntityTx } from '../entity/tx-validation';
import { decode, encode } from '../storage/snapshot-coder';
import type { PersistedActivityJournal } from '../storage/views/activity-types';

const repoRoot = process.cwd();
const roots = ['runtime', 'frontend/src', 'scripts', 'tools', 'jurisdictions'];
const excludedDirectories = new Set([
  '__tests__', 'test', 'tests', 'scenarios', 'fixtures', 'generated', 'static',
]);
const allowedMentions = {
  'runtime/api/public/activity-history.ts': 1,
  'runtime/entity/htlc/note-index.ts': 1,
  'runtime/entity/tx-validation/payment-schemas.ts': 1,
  'runtime/entity/tx/apply.ts': 2,
  'runtime/entity/tx/catalog.ts': 1,
  'runtime/entity/tx/handlers/htlc-direct.ts': 1,
  'runtime/types/entity-tx.ts': 1,
};

const collectFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(path);
    return entry.isFile() ? [path] : [];
  });

test('legacy hashlockPayment stays confined to its frozen production surface', () => {
  const mentions = Object.fromEntries(
    roots.flatMap(root => collectFiles(join(repoRoot, root)))
      .map(path => [
        relative(repoRoot, path),
        readFileSync(path, 'utf8').match(/hashlockPayment/g)?.length ?? 0,
      ] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  expect(mentions).toEqual(allowedMentions);
});

test('persisted legacy payload still decodes and preserves its activity rawType', () => {
  const alice = `0x${'11'.repeat(32)}`;
  const bob = `0x${'22'.repeat(32)}`;
  const payload = {
    type: 'hashlockPayment' as const,
    data: { targetEntityId: bob, tokenId: 1, amount: 7n, hashlock: `0x${'33'.repeat(32)}` },
  };
  const journal = decode<PersistedActivityJournal>(encode({
    height: 9,
    timestamp: 1_700_000_000_000,
    runtimeInput: { runtimeTxs: [], entityInputs: [{ entityId: alice, entityTxs: [payload] }] },
    logs: [],
  }));
  const restored = journal.runtimeInput?.entityInputs[0]?.entityTxs?.[0];
  expect(validateEntityTx(restored, 'LEGACY_HASHLOCK_WAL')).toEqual(payload);
  expect(buildRuntimeActivityEvents(journal, { entityId: alice })[0]?.rawType)
    .toBe('hashlockPayment');
});
