import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';

test('strict ACK timeout shorter than resend is rejected at boot', () => {
  const result = spawnSync(process.execPath, ['-e', 'import "./core/entity/scheduler/config/timing.ts"'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      XLN_ACCOUNT_ACK_STRICT_TIMEOUT_MS: '3000',
      XLN_ACCOUNT_PENDING_RESEND_AFTER_MS: '8000',
    },
  });
  expect(result.status).not.toBe(0);
  expect(`${result.stderr}${result.stdout}`).toContain('ACCOUNT_ACK_STRICT_TIMEOUT_MS_MUST_EXCEED_RESEND');
});
