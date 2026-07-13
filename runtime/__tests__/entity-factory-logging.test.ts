import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLazyEntity, encodeBoard, generateLazyEntityId, hashBoard } from '../entity/factory';

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

test('entity factory uses structured logging without direct console output', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/entity/factory.ts'), 'utf8');

  expect(source).toContain("const factoryLog = createStructuredLogger('entity.factory');");
  expect(source).toContain("factoryLog.debug('lazy.create'");
  expect(source).toContain("factoryLog.debug('numbered.create'");
  expect(source).toContain("factoryLog.error('numbered.register_failed'");
  expect(source).not.toContain('console.');
});

test('lazy entity identity preserves governance and leader order', () => {
  const validators = [
    '0x2222222222222222222222222222222222222222',
    '0x1111111111111111111111111111111111111111',
  ];
  const { config } = createLazyEntity('ordered-board', validators, 2n);

  expect(config.validators).toEqual(validators);
  expect(generateLazyEntityId(validators, 2n)).toBe(hashBoard(encodeBoard(config)));
  expect(generateLazyEntityId([...validators].reverse(), 2n)).not.toBe(generateLazyEntityId(validators, 2n));
});
