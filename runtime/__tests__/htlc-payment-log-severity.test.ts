import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('expected HTLC capacity rejection is informational, not a browser error', () => {
  const source = readFileSync(
    join(process.cwd(), 'runtime/entity/tx/handlers/htlc-payment.ts'),
    'utf8',
  );
  const start = source.indexOf('if (prepared.senderLockAmount > nextHopCapacity)');
  const end = source.indexOf('newState.htlcRoutes.set', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  const rejectionBranch = source.slice(start, end);
  expect(rejectionBranch).toContain("htlcLog.info('rejected'");
  expect(rejectionBranch).toContain("reason: 'insufficient-capacity'");
  expect(rejectionBranch).not.toContain('htlcLog.error');
  expect(rejectionBranch).toContain('HTLC payment failed: insufficient capacity');
});
