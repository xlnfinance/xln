import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('frame commit fsyncs authoritative WAL before updating the rebuildable cache', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/storage/index.ts'), 'utf8');
  const commitStart = source.indexOf('const commitStorageFrame = async');
  const commitEnd = source.indexOf('type CommittedStorageFrame', commitStart);
  const commit = source.slice(commitStart, commitEnd);
  const authoritative = commit.indexOf(
    'await writeBatch(batches.walBatch, { sync: true });',
  );
  const boundary = commit.indexOf(
    "'after-authoritative-history-commit'",
    authoritative,
  );
  const cache = commit.indexOf(
    'await writeBatch(batches.currentBatch, { sync: false });',
    boundary,
  );

  expect(commitStart).toBeGreaterThanOrEqual(0);
  expect(commitEnd).toBeGreaterThan(commitStart);
  expect(authoritative).toBeGreaterThanOrEqual(0);
  expect(boundary).toBeGreaterThan(authoritative);
  expect(cache).toBeGreaterThan(boundary);
});
