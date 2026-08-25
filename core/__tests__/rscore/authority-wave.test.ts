import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  authorityRecordReport,
  beginAuthorityFrame,
  buildAuthorityWave,
  describeAuthorityWaveOperation,
  flushAuthorityFrame,
  noteAuthorityEntityClock,
  noteRawAccountInput,
  resetAuthorityRecordForTests,
  runAuthorityFrameScope,
} from '../../rscore/authority-wave';
import { waveCreateOp } from '../../rscore/shadow-wire';
import type { AccountFrame, AccountInput, AccountReplica, AccountTx } from '../../types/account';

/**
 * One process hosts up to two hundred Runtimes in a load run, and their frames
 * overlap. Everything here is about attribution: an input recorded against the
 * wrong Runtime is an input the authoritative engine for that Runtime never
 * receives, and the divergence would surface as a wrong frame hash somewhere
 * else entirely.
 */

const replica = (owner: string, counterparty: string): AccountReplica =>
  ({ proofHeader: { fromEntity: owner, toEntity: counterparty } } as unknown as AccountReplica);

const enqueue = (txs: AccountTx[] = []): AccountInput =>
  ({ kind: 'enqueue', txs } as unknown as AccountInput);

const payment = (to: string): AccountTx => ({
  type: 'direct_payment',
  data: { tokenId: 1, amount: 25n, route: [to], fromEntityId: A, toEntityId: to, deliveryMode: 'direct' },
});

const frameOf = (height: number): AccountFrame => ({
  height,
  timestamp: 1_700_000_000_000,
  jHeight: 100,
  accountTxs: [],
  prevFrameHash: 'genesis',
  accountStateRoot: `0x${'33'.repeat(32)}`,
  byLeft: true,
  stateHash: `0x${'44'.repeat(32)}`,
} as unknown as AccountFrame);

const frameAck = (height: number): AccountInput => ({
  kind: 'frame_ack',
  ack: { height: height - 1, frameHash: `0x${'55'.repeat(32)}`, frameHanko: `0x${'66'.repeat(64)}` },
  proposal: { frame: frameOf(height), frameHanko: `0x${'77'.repeat(64)}` },
} as unknown as AccountInput);

const A = `0x${'aa'.repeat(32)}`;
const B = `0x${'bb'.repeat(32)}`;
const C = `0x${'cc'.repeat(32)}`;

describe('authority record', () => {
  beforeEach(() => {
    process.env['XLN_RSCORE_AUTHORITY_RECORD'] = '1';
    resetAuthorityRecordForTests();
  });
  afterEach(() => {
    delete process.env['XLN_RSCORE_AUTHORITY_RECORD'];
    resetAuthorityRecordForTests();
  });

  test('two Runtimes with overlapping frames keep their own inputs', () => {
    beginAuthorityFrame('runtime-a');
    noteRawAccountInput('runtime-a', replica(A, B), enqueue());
    beginAuthorityFrame('runtime-b');
    noteRawAccountInput('runtime-b', replica(A, C), enqueue());
    // Back to A while B is still open: an active-Runtime pointer would have
    // put this in B's frame.
    noteRawAccountInput('runtime-a', replica(A, B), enqueue());
    flushAuthorityFrame('runtime-b');
    flushAuthorityFrame('runtime-a');

    const report = authorityRecordReport();
    expect(report.frames).toBe(2);
    expect(report.inputs).toBe(3);
    expect(report.skippedNoFrame).toBe(0);
  });

  test('a frame abandoned by a throw is dropped, not merged into the next', () => {
    beginAuthorityFrame('runtime-a');
    noteRawAccountInput('runtime-a', replica(A, B), enqueue());
    // No flush: the reducer threw. The next frame for the same Runtime finds
    // the old one still open.
    beginAuthorityFrame('runtime-a');
    noteRawAccountInput('runtime-a', replica(A, C), enqueue());
    flushAuthorityFrame('runtime-a');

    const report = authorityRecordReport();
    expect(report.abandonedFrames).toBe(1);
    expect(report.frames).toBe(1);
    expect(report.inputs).toBe(1);
  });

  test('an input with no Runtime is counted, never attributed to another', () => {
    beginAuthorityFrame('runtime-a');
    noteRawAccountInput(undefined, replica(A, B), enqueue());
    flushAuthorityFrame('runtime-a');

    const report = authorityRecordReport();
    expect(report.skippedNoFrame).toBe(1);
    expect(report.inputs).toBe(0);
  });

  test('a detached replay cannot append to a live frame with the same Runtime id', async () => {
    const live: { accountAuthorityFrameId?: string | null | undefined } = {};
    const detached: { accountAuthorityFrameId?: string | null | undefined } = {};
    await runAuthorityFrameScope(live, 'runtime-a', true, async frameId => {
      if (frameId === null) throw new Error('expected live authority frame');
      noteAuthorityEntityClock(live.accountAuthorityFrameId, A, 'enforce', 1_700_000_000_000, 100);
      noteRawAccountInput(live.accountAuthorityFrameId, replica(A, B), enqueue());

      await runAuthorityFrameScope(detached, 'runtime-a', false, async () => {
        noteAuthorityEntityClock(
          detached.accountAuthorityFrameId,
          A,
          'enforce',
          1_700_000_000_999,
          999,
        );
        noteRawAccountInput(detached.accountAuthorityFrameId, replica(A, C), enqueue());
      });

      const wave = buildAuthorityWave(frameId);
      expect(wave.kind).toBe('wave');
      if (wave.kind !== 'wave') throw new Error('expected a wave');
      expect(wave.entities).toHaveLength(1);
      const entity = wave.entities[0];
      if (!entity) throw new Error('expected one authority Entity');
      expect(entity.ops).toHaveLength(1);
      expect(entity.finalizedJHeight).toBe(100);
    });

    const report = authorityRecordReport();
    expect(report.frames).toBe(1);
    expect(report.inputs).toBe(1);
    expect(report.skippedNoFrame).toBe(0);
  });

  test('a frame touching two owner Entities is reported as such', () => {
    // Each Entity carries its own enforcement clock, so this frame cannot be
    // one wave with one clock.
    beginAuthorityFrame('runtime-a');
    noteRawAccountInput('runtime-a', replica(A, B), enqueue());
    noteRawAccountInput('runtime-a', replica(C, B), enqueue());
    flushAuthorityFrame('runtime-a');

    const report = authorityRecordReport();
    expect(report.framesWithMultipleOwners).toBe(1);
    expect(report.maxOwnersPerFrame).toBe(2);
  });
});

/**
 * The wave the collector assembles is what the authoritative engine is asked
 * to reproduce. Order and clocks are the whole content of these tests: an
 * operation in the wrong place builds a different mempool, and a clock from
 * the wrong Entity settles the wrong locks.
 */
describe('authority wave', () => {
  beforeEach(() => {
    process.env['XLN_RSCORE_AUTHORITY_RECORD'] = '1';
    resetAuthorityRecordForTests();
  });
  afterEach(() => {
    delete process.env['XLN_RSCORE_AUTHORITY_RECORD'];
    resetAuthorityRecordForTests();
  });

  test('one delivery that acknowledges and proposes becomes two operations, ack first', () => {
    beginAuthorityFrame('r');
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    noteRawAccountInput('r', replica(A, B), frameAck(4));
    const wave = buildAuthorityWave('r');

    expect(wave.kind).toBe('wave');
    if (wave.kind !== 'wave') throw new Error('expected a wave');
    expect(wave.entities).toHaveLength(1);
    const entity = wave.entities[0];
    if (entity === undefined) throw new Error('expected one Entity');
    const ops = entity.ops as unknown[][];
    expect(ops).toHaveLength(2);
    // TypeScript runs the ack phase before the proposal phase, and so does the
    // wave: the ack advances the account the frame is then judged against.
    expect(wave.inputs.map(row => row.kind)).toEqual(['ack', 'frame']);
    expect(wave.inputs.map(row => row.operationIndex)).toEqual([0, 1]);
    expect(entity.operations).toEqual([
      { operationIndex: 0, arrivalIndex: 0, accountId: B, resultKind: 'applied' },
      { operationIndex: 1, arrivalIndex: 1, accountId: B, resultKind: 'applied' },
    ]);
    // Both are input operations (tag 1), addressed to the same account.
    expect(ops.map(op => op[0])).toEqual([1, 1]);
    expect(ops.map(op => (op[1] as unknown[])[0])).toEqual([0, 1]);
  });

  test('each Entity carries its own clock, and one that never proposed does not', () => {
    beginAuthorityFrame('r');
    noteAuthorityEntityClock('r', A, 'propose', 1_700_000_000_000, 100);
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_500, 101);
    noteRawAccountInput('r', replica(A, B), enqueue([payment(B)]));
    noteAuthorityEntityClock('r', C, 'enforce', 1_700_000_009_000, 77);
    noteRawAccountInput('r', replica(C, B), frameAck(2));
    const wave = buildAuthorityWave('r');

    if (wave.kind !== 'wave') throw new Error('expected a wave');
    expect(wave.entities).toHaveLength(2);
    const [first, second] = wave.entities;
    expect(first!.ownerEntityId).toBe(A);
    expect(first!.propose).toBe(true);
    expect(first!.timestamp).toBe(1_700_000_000_000);
    expect(first!.jHeight).toBe(100);
    // Enforcement is judged on the Entity's own clock, not the one it stamps
    // proposals with.
    expect(first!.entityTimestamp).toBe(1_700_000_000_500);
    expect(first!.finalizedJHeight).toBe(101);
    expect(second!.ownerEntityId).toBe(C);
    expect(second!.propose).toBe(false);
    expect(second!.entityTimestamp).toBe(1_700_000_009_000);
    expect(second!.finalizedJHeight).toBe(77);
  });

  test('a transaction outside the profile makes the whole frame undrivable', () => {
    beginAuthorityFrame('r');
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    noteRawAccountInput('r', replica(A, B), enqueue([
      { type: 'settle_hold', data: {} } as unknown as AccountTx,
    ]));
    const wave = buildAuthorityWave('r');

    // Not "skip the transaction": the engine would build a different mempool
    // and every frame after it would disagree.
    expect(wave.kind).toBe('ineligible');
    if (wave.kind !== 'ineligible') throw new Error('expected ineligible');
    expect(wave.reason).toBe('tx:settle_hold');
  });

  test('an Entity with no clock is refused rather than given a neighbour to borrow', () => {
    beginAuthorityFrame('r');
    noteRawAccountInput('r', replica(A, B), enqueue([payment(B)]));
    const wave = buildAuthorityWave('r');

    expect(wave.kind).toBe('ineligible');
    if (wave.kind !== 'ineligible') throw new Error('expected ineligible');
    expect(wave.reason).toBe(`clock:missing:${A}`);
  });

  test('a frame with nothing in it is empty, not a wave with no work', () => {
    beginAuthorityFrame('r');
    expect(buildAuthorityWave('r').kind).toBe('empty');
    flushAuthorityFrame('r');
  });

  test('Create is explicitly classified as an operation with no result row', () => {
    const seed = [Uint8Array.from(Buffer.from(B.slice(2), 'hex'))];
    expect(describeAuthorityWaveOperation(waveCreateOp(9, seed))).toEqual({
      operationIndex: 9,
      accountId: B,
      resultKind: 'none',
    });
  });
});

/**
 * Guards on the collector itself. Each of these was a way to build a wave that
 * looks fine and is not the frame TypeScript actually processed.
 */
describe('authority wave guards', () => {
  beforeEach(() => {
    process.env['XLN_RSCORE_AUTHORITY_RECORD'] = '1';
    resetAuthorityRecordForTests();
  });
  afterEach(() => {
    delete process.env['XLN_RSCORE_AUTHORITY_RECORD'];
    resetAuthorityRecordForTests();
  });

  test('two different clocks for one Entity refuse the frame instead of keeping the last', () => {
    beginAuthorityFrame('r');
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    noteRawAccountInput('r', replica(A, B), frameAck(2));
    // The same Entity, judged again at a different J height inside one frame:
    // the Runtime frame is then not this Entity's wave unit.
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 101);
    noteRawAccountInput('r', replica(A, C), frameAck(2));
    const wave = buildAuthorityWave('r');

    expect(wave.kind).toBe('ineligible');
    if (wave.kind !== 'ineligible') throw new Error('expected ineligible');
    expect(wave.reason).toBe(`clock:enforce:${A}`);
  });

  test('the same clock recorded twice is not a conflict', () => {
    beginAuthorityFrame('r');
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    noteRawAccountInput('r', replica(A, B), frameAck(2));
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    expect(buildAuthorityWave('r').kind).toBe('wave');
  });

  test('grouping reorders the request but never the arrival order it reports', () => {
    beginAuthorityFrame('r');
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    noteAuthorityEntityClock('r', C, 'enforce', 1_700_000_000_000, 100);
    // A, then C, then A again: grouping sends A's two inputs together.
    noteRawAccountInput('r', replica(A, B), enqueue([payment(B)]));
    noteRawAccountInput('r', replica(C, B), frameAck(2));
    noteRawAccountInput('r', replica(A, B), frameAck(3));
    const wave = buildAuthorityWave('r');

    if (wave.kind !== 'wave') throw new Error('expected a wave');
    // Sent as A's group first, so A's ack/frame take indices 0..1 — but they
    // arrived at positions 3 and 4, after C's two operations.
    // The A admission consumes operation 0 before its two peer operations.
    expect(wave.inputs.map(row => row.operationIndex)).toEqual([1, 2, 3, 4]);
    expect(wave.inputs.map(row => row.arrivalIndex)).toEqual([3, 4, 1, 2]);
    expect(wave.inputs.map(row => row.ownerEntityId)).toEqual([A, A, C, C]);
    expect(wave.entities.flatMap(entity => entity.operations)).toEqual([
      { operationIndex: 0, arrivalIndex: 0, accountId: B, resultKind: 'admission' },
      { operationIndex: 1, arrivalIndex: 3, accountId: B, resultKind: 'applied' },
      { operationIndex: 2, arrivalIndex: 4, accountId: B, resultKind: 'applied' },
      { operationIndex: 3, arrivalIndex: 1, accountId: B, resultKind: 'applied' },
      { operationIndex: 4, arrivalIndex: 2, accountId: B, resultKind: 'applied' },
    ]);
    expect(wave.entities.flatMap(entity => entity.operations)
      .sort((left, right) => left.arrivalIndex - right.arrivalIndex)
      .map(row => row.operationIndex)).toEqual([0, 3, 4, 1, 2]);
    const groupedOps = wave.entities.flatMap(entity => entity.ops) as unknown[][];
    expect(groupedOps.map(op => op[0] === 0 ? op[1] : (op[1] as unknown[])[0]))
      .toEqual([0, 1, 2, 3, 4]);
  });

  test('a Hanko that is not hex is refused, never read as zero bytes', () => {
    beginAuthorityFrame('r');
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    noteRawAccountInput('r', replica(A, B), {
      kind: 'ack',
      ack: { height: 1, frameHash: `0x${'55'.repeat(32)}`, frameHanko: '0xzzzz' },
    } as unknown as AccountInput);
    const wave = buildAuthorityWave('r');

    expect(wave.kind).toBe('ineligible');
    if (wave.kind !== 'ineligible') throw new Error('expected ineligible');
    expect(wave.reason).toContain('hankoInvalid');
  });
});
