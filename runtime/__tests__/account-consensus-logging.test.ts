import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('account consensus core uses structured logging only', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/account/consensus/index.ts'), 'utf8');

  expect(source).toContain("createStructuredLogger('account')");
  expect(source).toContain("accountLog.error('frame.commit.failed'");
  expect(source).toContain("accountLog.warn('frame.prev_hash_mismatch'");
  expect(source).toContain("accountLog.warn('frame.state_root_mismatch'");
  expect(source).toContain("accountLog.debug('return.no_response'");
  expect(source).not.toContain('console.');
});

test('account consensus helper diagnostics use structured logging only', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/account/consensus/helpers.ts'), 'utf8');

  expect(source).toContain("createStructuredLogger('account.consensus')");
  expect(source).toContain("accountConsensusHelperLog.error('auto_rebalance_check.failed'");
  expect(source).toContain('throw rebalanceErr;');
  expect(source).not.toContain('console.');
});
