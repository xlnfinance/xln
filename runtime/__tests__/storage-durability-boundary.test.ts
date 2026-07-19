import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('frame commit fsyncs authoritative WAL before updating the rebuildable cache', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/storage/index.ts'), 'utf8');
  const authoritative = source.indexOf('await writeBatch(historyBatch, { sync: true });');
  const boundary = source.indexOf("'after-authoritative-history-commit'", authoritative);
  const cache = source.indexOf('await writeBatch(batch, { sync: false });', boundary);

  expect(authoritative).toBeGreaterThanOrEqual(0);
  expect(boundary).toBeGreaterThan(authoritative);
  expect(cache).toBeGreaterThan(boundary);
});
