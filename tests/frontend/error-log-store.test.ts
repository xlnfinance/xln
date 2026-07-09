import { expect, test } from 'bun:test';

import { formatErrorLog } from '../../frontend/src/lib/stores/errorLogStore';

test('error log formatter preserves Error and BigInt diagnostic details', () => {
  const error = new Error('projection failed');
  const circular: Record<string, unknown> = { error, amount: 42n };
  circular.self = circular;

  const output = formatErrorLog([{
    timestamp: 0,
    source: 'Runtime View',
    message: 'RuntimeView projection failed',
    details: circular,
  }]);

  expect(output).toContain('Runtime View: RuntimeView projection failed');
  expect(output).toContain('"message":"projection failed"');
  expect(output).toContain('"amount":"BigInt(42)"');
  expect(output).toContain('"self":"[Circular]"');
  expect(output).not.toContain('[unserializable details]');
});
