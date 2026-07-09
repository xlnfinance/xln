import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('same-jurisdiction orderbook matching uses structured logging only', () => {
  const source = readFileSync(
    join(process.cwd(), 'runtime/entity-tx/handlers/account/orderbook-matching-same.ts'),
    'utf8',
  );

  expect(source).toContain("const orderbookSameLog = createStructuredLogger('orderbook.same');");
  expect(source).not.toContain('console.');
  expect(source).toContain('orderbookSameLog.debug');
});
