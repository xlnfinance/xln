import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readRuntimeSource = (path: string): string =>
  readFileSync(join(process.cwd(), path), 'utf8');

test('account committed followups use structured logging only', () => {
  const frameFollowups = readRuntimeSource('runtime/entity-tx/handlers/account/committed-frame-followups.ts');
  const htlcFollowups = readRuntimeSource('runtime/entity-tx/handlers/account/committed-htlc-followups.ts');

  expect(frameFollowups).toContain("createStructuredLogger('account.followup')");
  expect(frameFollowups).toContain("accountFollowupLog.debug('frame.commit'");
  expect(frameFollowups).toContain("accountFollowupLog.debug('frame.tx'");
  expect(frameFollowups).not.toContain('console.');

  expect(htlcFollowups).toContain("createStructuredLogger('account.followup')");
  expect(htlcFollowups).toContain("accountFollowupLog.debug('htlc.secret_check'");
  expect(htlcFollowups).not.toContain('console.');
});
