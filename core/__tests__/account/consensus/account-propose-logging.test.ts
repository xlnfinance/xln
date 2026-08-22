import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('account frame proposal path uses structured logging only', () => {
  const files = [
    'proposal/propose.ts',
    'proposal/admission.ts',
    'proposal/frame.ts',
    'proposal/proof.ts',
    'proposal/transactions.ts',
  ];
  const source = files.map(file =>
    readFileSync(join(process.cwd(), 'core/account/consensus', file), 'utf8')
  ).join('\n');

  expect(source).toContain("createStructuredLogger('account')");
  expect(source).toContain("accountLog.debug('proof.header'");
  expect(source).toContain("accountLog.warn('frame.validation_failed'");
  expect(source).toContain("accountLog.warn : accountLog.info");
  expect(source).not.toContain('console.');
  expect(source).not.toContain('markProfile');
  expect(source).not.toContain('profileMarks');
});
