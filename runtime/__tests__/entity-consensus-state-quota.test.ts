import { expect, test } from 'bun:test';

import {
  DEFAULT_ENTITY_CONSENSUS_STATE_WARNING_BYTES,
  MAX_ENTITY_CONSENSUS_STATE_WARNING_BYTES,
  classifyEntityConsensusStateQuotaTransition,
  measureEntityConsensusStateBytes,
  validateEntityConsensusStateQuotaConfig,
  type EntityConsensusStateConsumptionAdapter,
} from '../entity/consensus/state-quota';
import { encodeCanonicalEntityConsensusState } from '../entity/consensus/state-root';
import type { ConsumptionAccumulatorState } from '../entity/consumption-accumulator';
import type { EntityState } from '../types';

const entityId = `0x${'11'.repeat(32)}`;

const baseState = (): EntityState => ({
  entityId,
  height: 1,
  timestamp: 100,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: { mode: 'proposer-based', threshold: 1n, validators: ['1'], shares: { '1': 1n } },
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  certifiedBoardState: {
    stackKey: `0x${'01'.repeat(32)}`,
    boardRegistryRoot: `0x${'02'.repeat(32)}`,
    finalizedJHeight: 1,
    finalizedJBlockHash: `0x${'03'.repeat(32)}`,
    eventHistoryRoot: `0x${'04'.repeat(32)}`,
  },
  entityEncPubKey: 'local-public-key',
  entityEncPrivKey: 'local-private-key',
  profile: { name: 'quota', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
});

test('quota config defaults to 1 GiB and accepts the exact 10 TiB hard maximum', () => {
  expect(DEFAULT_ENTITY_CONSENSUS_STATE_WARNING_BYTES).toBe(1_073_741_824);
  expect(MAX_ENTITY_CONSENSUS_STATE_WARNING_BYTES).toBe(10_995_116_277_760);
  expect(validateEntityConsensusStateQuotaConfig()).toEqual({
    warningBytes: DEFAULT_ENTITY_CONSENSUS_STATE_WARNING_BYTES,
  });
  expect(validateEntityConsensusStateQuotaConfig({
    warningBytes: MAX_ENTITY_CONSENSUS_STATE_WARNING_BYTES,
  })).toEqual({ warningBytes: MAX_ENTITY_CONSENSUS_STATE_WARNING_BYTES });
});

test('quota config rejects every malformed or out-of-range limit', () => {
  const malformed: unknown[] = [
    null,
    {},
    [],
    { warningBytes: 0 },
    { warningBytes: -1 },
    { warningBytes: 1.5 },
    { warningBytes: Number.NaN },
    { warningBytes: Number.POSITIVE_INFINITY },
    { warningBytes: Number.MAX_SAFE_INTEGER + 1 },
    { warningBytes: 1n },
    { warningBytes: '1024' },
    { warningBytes: MAX_ENTITY_CONSENSUS_STATE_WARNING_BYTES + 1 },
    { warningBytes: 1024, extra: true },
    Object.defineProperty({}, 'warningBytes', { enumerable: true, get: () => 1024 }),
  ];
  for (const value of malformed) {
    expect(() => validateEntityConsensusStateQuotaConfig(value), String(value)).toThrow('ENTITY_STATE_QUOTA_');
  }
});

test('measurement uses the canonical Entity encoding and preserves BigInt exactly', () => {
  const left = baseState();
  left.nonces = new Map([['b', 2], ['a', 1]]);
  left.htlcFeesEarned = (1n << 200n) + 123n;
  const right = baseState();
  right.nonces = new Map([['a', 1], ['b', 2]]);
  right.htlcFeesEarned = (1n << 200n) + 123n;

  const encoded = encodeCanonicalEntityConsensusState(left);
  const exactBytes = BigInt(new TextEncoder().encode(encoded).byteLength);
  expect(encoded).toContain(`\"BigInt\",\"${left.htlcFeesEarned.toString()}\"`);
  expect(measureEntityConsensusStateBytes(left)).toEqual({
    canonicalBytes: exactBytes,
    consumptionTreeBytes: 0n,
    totalBytes: exactBytes,
  });
  expect(measureEntityConsensusStateBytes(right)).toEqual(measureEntityConsensusStateBytes(left));
});

test('optional accumulator adapter adds exact conceptual Patricia bytes', () => {
  const state = baseState();
  const accumulator: ConsumptionAccumulatorState = {
    version: 2,
    root: `0x${'22'.repeat(32)}`,
    count: 2n,
  };
  const adapter: EntityConsensusStateConsumptionAdapter = {
    getAccumulatorState: () => accumulator,
  };
  const withoutAccumulator = measureEntityConsensusStateBytes(state);
  const withAccumulator = measureEntityConsensusStateBytes(state, adapter);

  expect(withAccumulator.canonicalBytes).toBe(withoutAccumulator.canonicalBytes);
  expect(withAccumulator.consumptionTreeBytes).toBe(364n);
  expect(withAccumulator.totalBytes).toBe(withoutAccumulator.totalBytes + 364n);
  expect(() => measureEntityConsensusStateBytes(state, {
    getAccumulatorState: () => ({ count: -1n }),
  })).toThrow('CONSUMPTION_COUNT_INVALID');
});

test('exact threshold is within while over-threshold growth is only classified as a warning', () => {
  const limit = BigInt(DEFAULT_ENTITY_CONSENSUS_STATE_WARNING_BYTES);
  expect(classifyEntityConsensusStateQuotaTransition(limit - 1n, limit).classification).toBe('within');

  const growth = classifyEntityConsensusStateQuotaTransition(limit, limit + 1n);
  expect(growth).toEqual({
    classification: 'warning_growth',
    warningBytes: limit,
    preStateBytes: limit,
    postStateBytes: limit + 1n,
    overageBytes: 1n,
  });
});

test('over-threshold equal or shrinking transitions are cleanup-safe warnings', () => {
  const config = { warningBytes: 10 };
  expect(classifyEntityConsensusStateQuotaTransition(11n, 11n, config).classification)
    .toBe('warning_non_growth');
  expect(classifyEntityConsensusStateQuotaTransition(12n, 11n, config)).toEqual({
    classification: 'warning_non_growth',
    warningBytes: 10n,
    preStateBytes: 12n,
    postStateBytes: 11n,
    overageBytes: 1n,
  });
  expect(classifyEntityConsensusStateQuotaTransition(12n, 10n, config).classification).toBe('within');
});

test('transition arithmetic stays exact for huge BigInt sizes and rejects malformed lengths', () => {
  const huge = 1n << 200n;
  expect(classifyEntityConsensusStateQuotaTransition(huge, huge + 1n).classification)
    .toBe('warning_growth');
  expect(() => classifyEntityConsensusStateQuotaTransition(-1n, 0n)).toThrow(
    'ENTITY_STATE_QUOTA_PRE_BYTES_INVALID',
  );
  expect(() => classifyEntityConsensusStateQuotaTransition(
    0 as unknown as bigint,
    0n,
  )).toThrow('ENTITY_STATE_QUOTA_PRE_BYTES_INVALID');
});
