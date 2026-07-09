import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLazyEntity } from '../entity-factory';

test('createLazyEntity is silent when runtime DEBUG is disabled', () => {
  const originalLog = console.log;
  const messages: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    messages.push(args);
  };

  try {
    const result = createLazyEntity(
      'silent',
      ['0x1111111111111111111111111111111111111111'],
      1n,
    );
    expect(result.executionTimeMs).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(messages).toEqual([]);
});

test('entity factory console logs stay behind DEBUG', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/entity-factory.ts'), 'utf8');
  const offenders = source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.includes('console.log') && !line.includes('if (DEBUG)'));

  expect(offenders).toEqual([]);
});
