import { describe, expect, test } from 'bun:test';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../account/crypto';
import { applyJEvent } from '../entity/tx/j-events';
import {
  MAX_ENTITY_FRAME_J_RANGE_BYTES,
  assertEntityFrameJRangeBudget,
  canonicalEntityFrameJRangePayloadByteLength,
  canonicalJRangeBodiesByteLength,
  selectEntityTxsWithinJRangeBudget,
} from '../jurisdiction/range-budget';
import {
  buildCertifiedJPrefixTx,
  buildJPrefixCertificate,
  buildLocalJPrefixAttestation,
  mergeJPrefixAttestations,
  restoreJPrefixRound,
} from '../jurisdiction/j-prefix-consensus';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
import { EMPTY_J_HISTORY_ROOT } from '../jurisdiction/history-consensus';
import { recordValidatorJHistory } from '../jurisdiction/local-history';
import { createEmptyEnv } from '../runtime';
import type {
  EntityReplica,
  EntityState,
  EntityTx,
  Env,
  JurisdictionEventBlock,
  JurisdictionEventData,
  ValidatorJEventBlock,
  ValidatorJHistory,
} from '../types';

const HASH = `0x${'11'.repeat(32)}`;
const SIGNATURE = `0x${'22'.repeat(65)}`;

const eventBlock = (height: number, padding = ''): JurisdictionEventBlock => ({
  blockNumber: height,
  blockHash: HASH,
  eventsHash: HASH,
  events: [{
    blockNumber: height,
    blockHash: HASH,
    transactionHash: HASH,
    logIndex: 0,
    eventIndex: 0,
    type: 'SecretRevealed',
    data: { hashlock: HASH, revealer: HASH, secret: padding },
  }],
});

const rangeData = (
  baseHeight: number,
  scannedThroughHeight: number,
  blocks: JurisdictionEventBlock[] = [],
): JurisdictionEventData => ({
  from: `0x${'33'.repeat(20)}`,
  jurisdictionRef: `stack:31337:0x${'44'.repeat(20)}`,
  baseHeight,
  scannedThroughHeight,
  tipBlockHash: HASH,
  eventHistoryRoot: HASH,
  rangeHash: HASH,
  blocks,
  signature: SIGNATURE,
  observedAt: scannedThroughHeight,
});

const jRangeTx = (
  baseHeight: number,
  scannedThroughHeight: number,
  blocks: JurisdictionEventBlock[] = [],
): Extract<EntityTx, { type: 'j_event' }> => ({
  type: 'j_event',
  data: rangeData(baseHeight, scannedThroughHeight, blocks),
});

const ordinaryTx: EntityTx = {
  type: 'profile-update',
  data: { profile: { name: 'after-range' } },
};
const scheduledWakeTx: EntityTx = {
  type: 'scheduledWake',
  data: { version: 1, proposerSignerId: `0x${'33'.repeat(20)}`, dueAt: 1, jobs: [] },
};

const installSigner = (env: Env, label: string): string => {
  const signerId = deriveSignerAddressSync(env.runtimeSeed!, label).toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, label));
  return signerId;
};

const prefixState = (validators: string[]): EntityState => ({
  entityId: `0x${'55'.repeat(32)}`,
  height: 0,
  prevFrameHash: 'genesis',
  timestamp: 1_000,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: BigInt(validators.length),
    validators,
    shares: Object.fromEntries(validators.map((validator) => [validator, 1n])),
    jurisdiction: {
      name: 'JRangeBudget',
      address: 'http://127.0.0.1:8545',
      chainId: 31337,
      depositoryAddress: `0x${'44'.repeat(20)}`,
      entityProviderAddress: `0x${'66'.repeat(20)}`,
      registrationBlock: 10,
    },
  },
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 10,
  jBlockChain: [],
  jHistoryFinality: {
    jurisdictionRef: `stack:31337:0x${'44'.repeat(20)}`,
    baseHeight: 0,
    finalizedThroughHeight: 10,
    tipBlockHash: `0x${'0a'.padStart(64, '0')}`,
    eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
    proposerSignerId: validators[0]!,
    proposerSignature: '0xgenesis',
    entityHeight: 0,
  },
  entityEncPubKey: 'pub',
  entityEncPrivKey: 'priv',
  profile: { name: 'J budget', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

const historyThrough = (
  scannedThroughHeight: number,
  blocks: ValidatorJEventBlock[] = [],
): ValidatorJHistory => recordValidatorJHistory(undefined, {
  jurisdictionRef: `stack:31337:0x${'44'.repeat(20)}`,
  scannedThroughHeight,
  tipBlockHash: `0x${scannedThroughHeight.toString(16).padStart(64, '0')}`,
  headers: Array.from({ length: scannedThroughHeight - 9 }, (_, index) => {
    const jHeight = 10 + index;
    return { jHeight, jBlockHash: `0x${jHeight.toString(16).padStart(64, '0')}` };
  }),
  blocks,
});

const validatorEventBlock = (height: number): ValidatorJEventBlock => {
  const jBlockHash = `0x${height.toString(16).padStart(64, '0')}`;
  const events = eventBlock(height).events.map((event) => ({ ...event, blockHash: jBlockHash }));
  return {
    jurisdictionRef: `stack:31337:0x${'44'.repeat(20)}`,
    jHeight: height,
    jBlockHash,
    eventsHash: canonicalJurisdictionEventsHash(events),
    events,
  };
};

const withExactFramePayloadBytes = (targetBytes: number): EntityTx => {
  const empty = jRangeTx(10, 11, [eventBlock(11)]);
  const baseBytes = canonicalEntityFrameJRangePayloadByteLength([empty]);
  const paddingBytes = targetBytes - baseBytes;
  if (paddingBytes < 0) throw new Error(`TEST_TARGET_BELOW_BASE:${targetBytes}:${baseBytes}`);
  const exact = jRangeTx(10, 11, [eventBlock(11, 'x'.repeat(paddingBytes))]);
  const actual = canonicalEntityFrameJRangePayloadByteLength([exact]);
  if (actual !== targetBytes) throw new Error(`TEST_EXACT_PAYLOAD_SIZE_MISMATCH:${actual}:${targetBytes}`);
  return exact;
};

const withExactBodyPayloadBytes = (targetBytes: number): EntityTx => {
  const empty = jRangeTx(10, 11, [eventBlock(11)]);
  const baseBytes = canonicalJRangeBodiesByteLength([empty.data]);
  const paddingBytes = targetBytes - baseBytes;
  if (paddingBytes < 0) throw new Error(`TEST_BODY_TARGET_BELOW_BASE:${targetBytes}:${baseBytes}`);
  const exact = jRangeTx(10, 11, [eventBlock(11, 'x'.repeat(paddingBytes))]);
  const actual = canonicalJRangeBodiesByteLength([exact.data]);
  if (actual !== targetBytes) throw new Error(`TEST_EXACT_BODY_SIZE_MISMATCH:${actual}:${targetBytes}`);
  return exact;
};

describe('Entity frame J-range budget', () => {
  test('accepts every available contiguous height when the canonical payload fits 10 MiB', () => {
    expect(() => assertEntityFrameJRangeBudget([jRangeTx(100, 165)])).not.toThrow();
    expect(() => assertEntityFrameJRangeBudget([jRangeTx(100, 1_000_100)])).not.toThrow();
  });

  test('the state transition rejects an oversized byte payload before touching Entity state', async () => {
    const env = createEmptyEnv('j-range-budget-pre-mutation');
    const proposerId = installSigner(env, 'pre-mutation-proposer');
    const state = prefixState([proposerId]);
    state.leaderState = { activeValidatorId: proposerId, view: 0, changedAtHeight: 0 };
    const oversizedTx = withExactFramePayloadBytes(MAX_ENTITY_FRAME_J_RANGE_BYTES + 1);
    if (oversizedTx.type !== 'j_event') throw new Error('TEST_J_RANGE_TX_MISSING');
    const oversized = structuredClone(oversizedTx.data);
    oversized.from = proposerId;
    const before = structuredClone(state);

    await expect(applyJEvent(state, oversized, env))
      .rejects.toThrow(
        `J_RANGE_FRAME_BYTE_LIMIT_EXCEEDED:${MAX_ENTITY_FRAME_J_RANGE_BYTES + 1}:${MAX_ENTITY_FRAME_J_RANGE_BYTES}`,
      );
    expect(state).toEqual(before);
  });

  test('measures one canonical UTF-8 payload for the entire frame at 10 MiB / +1 boundaries', () => {
    const exact = withExactFramePayloadBytes(MAX_ENTITY_FRAME_J_RANGE_BYTES);
    expect(() => assertEntityFrameJRangeBudget([exact])).not.toThrow();

    const plusOne = withExactFramePayloadBytes(MAX_ENTITY_FRAME_J_RANGE_BYTES + 1);
    expect(() => assertEntityFrameJRangeBudget([plusOne]))
      .toThrow(`J_RANGE_FRAME_BYTE_LIMIT_EXCEEDED:${MAX_ENTITY_FRAME_J_RANGE_BYTES + 1}:${MAX_ENTITY_FRAME_J_RANGE_BYTES}`);

    const ascii = jRangeTx(10, 11, [eventBlock(11, 'x')]);
    const unicode = jRangeTx(10, 11, [eventBlock(11, '💥')]);
    expect(
      canonicalEntityFrameJRangePayloadByteLength([unicode]) -
      canonicalEntityFrameJRangePayloadByteLength([ascii]),
    ).toBe(3);
  });

  test('counts proposer authentication bytes instead of accepting a body-only 10 MiB payload', () => {
    const bodyAtLimit = withExactBodyPayloadBytes(MAX_ENTITY_FRAME_J_RANGE_BYTES);
    expect(canonicalJRangeBodiesByteLength([
      (bodyAtLimit as Extract<EntityTx, { type: 'j_event' }>).data,
    ])).toBe(MAX_ENTITY_FRAME_J_RANGE_BYTES);
    expect(canonicalEntityFrameJRangePayloadByteLength([bodyAtLimit]))
      .toBeGreaterThan(MAX_ENTITY_FRAME_J_RANGE_BYTES);
    expect(() => assertEntityFrameJRangeBudget([bodyAtLimit]))
      .toThrow('J_RANGE_FRAME_BYTE_LIMIT_EXCEEDED:');
  });

  test('aggregates more than 64 heights without deferring when the byte budget fits', () => {
    const first = jRangeTx(10, 42);
    const second = jRangeTx(42, 74);
    expect(() => assertEntityFrameJRangeBudget([first, second])).not.toThrow();

    const suffix = jRangeTx(74, 75);
    expect(() => assertEntityFrameJRangeBudget([first, second, suffix])).not.toThrow();

    const selected = selectEntityTxsWithinJRangeBudget([
      scheduledWakeTx,
      first,
      ordinaryTx,
      second,
      suffix,
    ]);
    expect(selected.txs).toEqual([scheduledWakeTx, first, ordinaryTx, second, suffix]);
    expect(selected.txs[0]).toBe(scheduledWakeTx);
    expect(selected.deferredJRangeCount).toBe(0);

    const laterOrdinary = structuredClone(ordinaryTx);
    const ordered = selectEntityTxsWithinJRangeBudget([
      first,
      second,
      suffix,
      laterOrdinary,
    ]);
    expect(ordered.txs).toEqual([first, second, suffix, laterOrdinary]);
  });

  test('defers a whole range when only the aggregate canonical byte budget is exceeded', () => {
    const first = withExactFramePayloadBytes(6 * 1024 * 1024);
    const second = withExactFramePayloadBytes(6 * 1024 * 1024);
    expect(() => assertEntityFrameJRangeBudget([first])).not.toThrow();
    expect(() => assertEntityFrameJRangeBudget([second])).not.toThrow();
    expect(() => assertEntityFrameJRangeBudget([first, second]))
      .toThrow('J_RANGE_FRAME_BYTE_LIMIT_EXCEEDED:');

    const selected = selectEntityTxsWithinJRangeBudget([first, second]);
    expect(selected.txs).toEqual([first]);
    expect(selected.deferredJRangeCount).toBe(1);
  });

  test('never splits a J-block and fails loudly when one block cannot fit', () => {
    const first = jRangeTx(10, 11, [eventBlock(11)]);
    const enormousBlock = withExactFramePayloadBytes(MAX_ENTITY_FRAME_J_RANGE_BYTES + 1);
    expect(() => selectEntityTxsWithinJRangeBudget([first, enormousBlock, ordinaryTx]))
      .toThrow('J_RANGE_SINGLE_RANGE_UNPROPOSABLE');
    expect(() => selectEntityTxsWithinJRangeBudget([enormousBlock]))
      .toThrow('J_RANGE_SINGLE_RANGE_UNPROPOSABLE');
  });
});

describe('budgeted exact J-prefix catch-up', () => {
  test('attests the entire available 65-block prefix when it fits the canonical byte budget', () => {
    const env = createEmptyEnv('j-range-budget-full-catch-up');
    const proposerId = installSigner(env, 'full-catch-up-proposer');
    const validatorId = installSigner(env, 'full-catch-up-validator');
    const state = prefixState([proposerId, validatorId]);
    const history = historyThrough(75, Array.from({ length: 65 }, (_, index) => validatorEventBlock(11 + index)));
    const proposerHead = buildLocalJPrefixAttestation(env, {
      entityId: state.entityId,
      signerId: proposerId,
      state,
      mempool: [],
      isProposer: true,
      jHistory: history,
    })!;

    expect(proposerHead.baseHeight).toBe(10);
    expect(proposerHead.scannedThroughHeight).toBe(75);
    expect(proposerHead.headers).toHaveLength(65);
    expect(proposerHead.blocks).toHaveLength(65);
    expect(canonicalEntityFrameJRangePayloadByteLength([{
      type: 'j_event',
      data: {
        from: proposerId,
        signature: SIGNATURE,
        observedAt: proposerHead.scannedThroughHeight,
        ...proposerHead,
      },
    }])).toBeLessThanOrEqual(MAX_ENTITY_FRAME_J_RANGE_BYTES);
  });

  test('certifies the full 65-block local head, restores identically, and leaves no suffix', () => {
    const env = createEmptyEnv('j-range-budget-catch-up');
    const proposerId = installSigner(env, 'budget-proposer');
    const validatorId = installSigner(env, 'budget-validator');
    const state = prefixState([proposerId, validatorId]);
    const history = historyThrough(75);
    const proposerReplica: EntityReplica = {
      entityId: state.entityId,
      signerId: proposerId,
      state: structuredClone(state),
      mempool: [],
      isProposer: true,
      jHistory: structuredClone(history),
    };
    const validatorReplica: EntityReplica = {
      ...proposerReplica,
      signerId: validatorId,
      isProposer: false,
      state: structuredClone(state),
      jHistory: structuredClone(history),
    };
    const proposerHead = buildLocalJPrefixAttestation(env, proposerReplica)!;
    const validatorHead = buildLocalJPrefixAttestation(env, validatorReplica)!;
    expect(proposerHead.scannedThroughHeight).toBe(75);
    expect(proposerHead.headers).toHaveLength(65);
    expect(validatorHead.scannedThroughHeight).toBe(75);

    const round = mergeJPrefixAttestations(env, state, undefined, new Map([
      [proposerId, proposerHead],
      [validatorId, validatorHead],
    ]));
    const restored = restoreJPrefixRound(env, state, structuredClone(round));
    expect(restored.certificate?.selected.scannedThroughHeight).toBe(75);
    const certificate = buildJPrefixCertificate(state, restored.attestations)!;
    const proposerTx = buildCertifiedJPrefixTx(env, proposerReplica, certificate, proposerId);
    const failoverTx = buildCertifiedJPrefixTx(env, proposerReplica, certificate, validatorId);
    expect(() => assertEntityFrameJRangeBudget([proposerTx])).not.toThrow();
    expect(() => assertEntityFrameJRangeBudget([failoverTx])).not.toThrow();
    expect(proposerTx.data.blocks).toEqual(failoverTx.data.blocks);

    const advancedState = structuredClone(state);
    advancedState.lastFinalizedJHeight = 75;
    advancedState.jHistoryFinality = {
      ...advancedState.jHistoryFinality!,
      baseHeight: 10,
      finalizedThroughHeight: 75,
      tipBlockHash: `0x${'4b'.padStart(64, '0')}`,
      entityHeight: 1,
    };
    const caughtUp = buildLocalJPrefixAttestation(env, {
      ...proposerReplica,
      state: advancedState,
      jHistory: history,
    })!;
    expect(caughtUp.baseHeight).toBe(75);
    expect(caughtUp.scannedThroughHeight).toBe(75);
    expect(caughtUp.headers).toHaveLength(0);
  });

  test('halts on a single event-bearing block whose canonical body exceeds 10 MiB', () => {
    const env = createEmptyEnv('j-range-budget-huge-block');
    const proposerId = installSigner(env, 'huge-block-proposer');
    const state = prefixState([proposerId]);
    const enormousTx = withExactBodyPayloadBytes(MAX_ENTITY_FRAME_J_RANGE_BYTES + 1);
    if (enormousTx.type !== 'j_event') throw new Error('TEST_J_RANGE_TX_MISSING');
    const block = structuredClone(enormousTx.data.blocks[0]!);
    block.blockHash = `0x${'0b'.padStart(64, '0')}`;
    block.events = block.events.map((event) => ({ ...event, blockHash: block.blockHash }));
    block.eventsHash = canonicalJurisdictionEventsHash(block.events);
    const history = historyThrough(11, [{
      jurisdictionRef: enormousTx.data.jurisdictionRef,
      jHeight: 11,
      jBlockHash: block.blockHash,
      eventsHash: block.eventsHash,
      events: block.events,
    }]);
    const replica: EntityReplica = {
      entityId: state.entityId,
      signerId: proposerId,
      state,
      mempool: [],
      isProposer: true,
      jHistory: history,
    };
    expect(() => buildLocalJPrefixAttestation(env, replica))
      .toThrow('J_RANGE_SINGLE_BLOCK_UNPROPOSABLE:11');
  });
});
