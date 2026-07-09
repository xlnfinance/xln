import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('j-batch success-path logs stay behind structured debug logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/j-batch.ts'), 'utf8');

  expect(source).toContain("const jBatchLog = createStructuredLogger('j.batch');");
  expect(source).not.toContain('console.log');
  expect(source).toContain('jBatchLog.debug');
});

test('r2c handler traces stay behind structured debug logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/entity-tx/handlers/r2c.ts'), 'utf8');

  expect(source).toContain("const r2cLog = createStructuredLogger('entity.r2c');");
  expect(source).not.toContain('console.log');
  expect(source).toContain('r2cLog.debug');
});

test('htlc payment handler traces stay behind structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/entity-tx/handlers/htlc-payment.ts'), 'utf8');

  expect(source).toContain("const htlcLog = createStructuredLogger('entity.htlc');");
  expect(source).not.toContain('console.');
  expect(source).toContain('htlcLog.debug');
  expect(source).toContain('htlcLog.error');
});

test('dispute handler traces stay behind structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/entity-tx/handlers/dispute.ts'), 'utf8');

  expect(source).toContain("const disputeLog = createStructuredLogger('entity.dispute');");
  expect(source).not.toContain('console.');
  expect(source).toContain('disputeLog.debug');
  expect(source).toContain('disputeLog.error');
  expect(source).toContain('disputeLog.warn');
});
