import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('account frame proposal path uses structured logging only', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/account/consensus/propose.ts'), 'utf8');

  expect(source).toContain("createStructuredLogger('account')");
  expect(source).toContain("accountLog.debug('proof.header'");
  expect(source).toContain("accountLog.warn('frame.validation_failed'");
  expect(source).toContain("accountLog.warn('proposal.profile'");
  expect(source).not.toContain('console.');
  expect(source).not.toContain('markProfile');
  expect(source).not.toContain('profileMarks');
});
