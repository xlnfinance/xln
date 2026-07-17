import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLazyEntity, encodeBoard, generateLazyEntityId, hashBoard } from '../entity/factory';
import { createEmptyEnv } from '../runtime';

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

test('lazy entity creation preserves exact configured board weights', () => {
  const weightedMembers = [
    { name: '0x1111111111111111111111111111111111111111', weight: 1 },
    { name: '0x2222222222222222222222222222222222222222', weight: 2 },
  ];
  const { config } = createLazyEntity(
    'weighted-board',
    weightedMembers,
    2n,
  );

  expect(config.validators).toEqual(weightedMembers.map((member) => member.name));
  expect(config.shares).toEqual({
    [weightedMembers[0]!.name]: 1n,
    [weightedMembers[1]!.name]: 2n,
  });
  expect(hashBoard(encodeBoard(config))).toBe(generateLazyEntityId(weightedMembers, 2n));
});

test('board proposer is an exact EOA while later numeric leaves remain seed-scoped', () => {
  const first = createEmptyEnv('factory numeric signer seed A');
  const second = createEmptyEnv('factory numeric signer seed B');
  expect(() => generateLazyEntityId(['1'], 1n, first)).toThrow('BOARD_PROPOSER_EOA_REQUIRED:1');
  const proposer = '0x1111111111111111111111111111111111111111';
  expect(generateLazyEntityId([proposer, '1'], 2n, first)).not.toBe(
    generateLazyEntityId([proposer, '1'], 2n, second),
  );
});

test('board encoding resolves share keys case-insensitively without defaulting voting power', () => {
  const upper = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const lower = upper.toLowerCase();
  const canonical = encodeBoard({
    mode: 'proposer-based',
    threshold: 2n,
    validators: [lower],
    shares: { [lower]: 2n },
  });
  expect(encodeBoard({
    mode: 'proposer-based',
    threshold: 2n,
    validators: [upper],
    shares: { [lower]: 2n },
  })).toBe(canonical);
  expect(() => encodeBoard({
    mode: 'proposer-based',
    threshold: 1n,
    validators: [lower],
    shares: {},
  })).toThrow('Board voting power missing');
});
