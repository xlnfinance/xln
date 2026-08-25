import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('frame commit fsyncs authoritative WAL before updating the rebuildable cache', () => {
  const source = readFileSync(join(process.cwd(), 'core/storage/index.ts'), 'utf8');
  const commitStart = source.indexOf('const commitStorageFrame = async');
  const commitEnd = source.indexOf('type CommittedStorageFrame', commitStart);
  const commit = source.slice(commitStart, commitEnd);
  const authoritative = commit.indexOf(
    'await writeAuthoritativeWalBatch(batches);',
  );
  const accountAuthority = commit.indexOf(
    'await options.accountAuthority?.afterWalCommit();',
    authoritative,
  );
  const boundary = commit.indexOf(
    "'after-authoritative-history-commit'",
    accountAuthority,
  );
  const cache = commit.indexOf(
    'writeBatch(batches.currentBatch, { sync: false })',
    boundary,
  );

  expect(commitStart).toBeGreaterThanOrEqual(0);
  expect(commitEnd).toBeGreaterThan(commitStart);
  expect(authoritative).toBeGreaterThanOrEqual(0);
  expect(accountAuthority).toBeGreaterThan(authoritative);
  expect(boundary).toBeGreaterThan(accountAuthority);
  expect(cache).toBeGreaterThan(boundary);
});
