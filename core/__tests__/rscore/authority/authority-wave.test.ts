import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  authorityRecordReport,
  beginAuthorityFrame,
  buildAuthorityWave,
  describeAuthorityWaveOperation,
  flushAuthorityFrame,
  noteAuthorityAccountProposal,
  noteAuthorityAccountProposalResult,
  noteAuthorityAccountInputResult,
  noteAuthorityEntityClock,
  noteRawAccountInput,
  resetAuthorityRecordForTests,
  runAuthorityFrameScope,
} from '../../../rscore/authority-wave';
import { waveCreateOp } from '../../../rscore/shadow-wire';
import type {
  AccountFrame,
  AccountInput,
  AccountReplica,
  AccountTx,
} from '../../../types/account';
import { proposeAccountFrameIdle } from '../../../account/consensus/result';

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

const recordAccountInput = (
  frameId: string | null | undefined,
  account: AccountReplica,
  input: AccountInput,
): void => {
  const recorded = noteRawAccountInput(frameId, account, input);
  noteAuthorityAccountInputResult(recorded, input.kind === 'enqueue'
    ? { ok: true, events: [], admittedAccountTxCount: input.txs.length }
    : { ok: true, events: [] });
};

const payment = (to: string): AccountTx => ({
  type: 'direct_payment',
  data: { tokenId: 1, amount: 25n, route: [to], fromEntityId: A, toEntityId: to, deliveryMode: 'direct' },
});

const frameOf = (height: number): AccountFrame => ({
  height,
  timestamp: 1_700_000_000_000,
  jHeight: 100,
  accountTxs: [],
  prevFrameHash: height === 1 ? 'genesis' : `0x${'32'.repeat(32)}`,
  accountStateRoot: `0x${'33'.repeat(32)}`,
  stateHash: `0x${'44'.repeat(32)}`,
});

const ackFrame = (height: number, fromEntityId = B, toEntityId = A): AccountInput => ({
  kind: 'ack_frame',
  fromEntityId,
  toEntityId,
  domain: { chainId: 31_337, depositoryAddress: `0x${'11'.repeat(20)}` },
  disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 20 },
  watchSeed: `0x${'22'.repeat(32)}`,
  ack: { height: height - 1, frameHash: `0x${'55'.repeat(32)}`, frameHanko: `0x${'66'.repeat(64)}` },
  proposal: { frame: frameOf(height), frameHanko: `0x${'77'.repeat(64)}` },
});

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
    recordAccountInput('runtime-a', replica(A, B), enqueue());
    beginAuthorityFrame('runtime-b');
    recordAccountInput('runtime-b', replica(A, C), enqueue());
    // Back to A while B is still open: an active-Runtime pointer would have
    // put this in B's frame.
    recordAccountInput('runtime-a', replica(A, B), enqueue());
    flushAuthorityFrame('runtime-b');
    flushAuthorityFrame('runtime-a');

    const report = authorityRecordReport();
    expect(report.frames).toBe(2);
    expect(report.inputs).toBe(3);
    expect(report.skippedNoFrame).toBe(0);
  });

  test('a frame abandoned by a throw is dropped, not merged into the next', () => {
    beginAuthorityFrame('runtime-a');
    recordAccountInput('runtime-a', replica(A, B), enqueue());
    // No flush: the reducer threw. The next frame for the same Runtime finds
    // the old one still open.
    beginAuthorityFrame('runtime-a');
    recordAccountInput('runtime-a', replica(A, C), enqueue());
    flushAuthorityFrame('runtime-a');

    const report = authorityRecordReport();
    expect(report.abandonedFrames).toBe(1);
    expect(report.frames).toBe(1);
    expect(report.inputs).toBe(1);
  });

  test('an input with no Runtime is counted, never attributed to another', () => {
    beginAuthorityFrame('runtime-a');
    recordAccountInput(undefined, replica(A, B), enqueue());
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
      recordAccountInput(live.accountAuthorityFrameId, replica(A, B), enqueue());

      await runAuthorityFrameScope(detached, 'runtime-a', false, async () => {
        noteAuthorityEntityClock(
          detached.accountAuthorityFrameId,
          A,
          'enforce',
          1_700_000_000_999,
          999,
        );
        recordAccountInput(detached.accountAuthorityFrameId, replica(A, C), enqueue());
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
    recordAccountInput('runtime-a', replica(A, B), enqueue());
    recordAccountInput('runtime-a', replica(C, B), enqueue());
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

  test('one ack_frame stays one operation with ACK before proposal inside its kind', () => {
    beginAuthorityFrame('r');
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    recordAccountInput('r', replica(A, B), ackFrame(4));
    const wave = buildAuthorityWave('r');

    expect(wave.kind).toBe('wave');
    if (wave.kind !== 'wave') throw new Error('expected a wave');
    expect(wave.entities).toHaveLength(1);
    const entity = wave.entities[0];
    if (entity === undefined) throw new Error('expected one Entity');
    const ops = entity.ops as unknown[][];
    expect(ops).toHaveLength(1);
    expect(wave.inputs.map(row => row.kind)).toEqual(['ack_frame']);
    expect(wave.inputs.map(row => row.operationIndex)).toEqual([0]);
    expect(entity.operations).toEqual([
      {
        operationIndex: 0,
        arrivalIndex: 0,
        accountId: B,
        resultKind: 'applied',
        expectedVerdict: {
          kind: 'input',
          outcome: 'applied',
          committedFrames: [],
          responseAckHanko: null,
          events: [],
        },
      },
    ]);
    // Wave input tag 1 contains one peer row. Its envelope kind tag 2 carries
    // ACK at slot 1 and proposal at slot 2, matching TypeScript phase order.
    expect(ops[0]?.[0]).toBe(1);
    expect((ops[0]?.[1] as unknown[])[0]).toBe(0);
    expect((((ops[0]?.[1] as unknown[])[2] as unknown[])[5] as unknown[])[0]).toBe(2);
  });

  test('each Entity carries its own clock, and one that never proposed does not', () => {
    beginAuthorityFrame('r');
    const proposal = noteAuthorityAccountProposal('r', A, B, 1_700_000_000_000, 100);
    noteAuthorityAccountProposalResult(proposal, proposeAccountFrameIdle({
      message: 'test idle',
      events: [],
      proposalDroppedTransactions: [],
    }));
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_500, 101);
    recordAccountInput('r', replica(A, B), enqueue([payment(B)]));
    noteAuthorityEntityClock('r', C, 'enforce', 1_700_000_009_000, 77);
    recordAccountInput('r', replica(C, B), ackFrame(2, B, C));
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

  test('a transaction outside the closed profile fails before a partial wave exists', () => {
    beginAuthorityFrame('r');
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    recordAccountInput('r', replica(A, B), enqueue([
      { type: 'settle_hold', data: {} } as unknown as AccountTx,
    ]));
    // Not "skip the transaction": the engine would build a different mempool
    // and every frame after it would disagree.
    expect(() => buildAuthorityWave('r')).toThrow('SHADOW_ACCOUNT_TX_UNREACHABLE');
  });

  test('an Entity with no clock is refused rather than given a neighbour to borrow', () => {
    beginAuthorityFrame('r');
    recordAccountInput('r', replica(A, B), enqueue([payment(B)]));
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
    recordAccountInput('r', replica(A, B), ackFrame(2));
    // The same Entity, judged again at a different J height inside one frame:
    // the Runtime frame is then not this Entity's wave unit.
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 101);
    recordAccountInput('r', replica(A, C), ackFrame(2, C, A));
    const wave = buildAuthorityWave('r');

    expect(wave.kind).toBe('ineligible');
    if (wave.kind !== 'ineligible') throw new Error('expected ineligible');
    expect(wave.reason).toBe(`clock:enforce:${A}`);
  });

  test('the same clock recorded twice is not a conflict', () => {
    beginAuthorityFrame('r');
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    recordAccountInput('r', replica(A, B), ackFrame(2));
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    expect(buildAuthorityWave('r').kind).toBe('wave');
  });

  test('grouping reorders the request but never the arrival order it reports', () => {
    beginAuthorityFrame('r');
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    noteAuthorityEntityClock('r', C, 'enforce', 1_700_000_000_000, 100);
    // A, then C, then A again: grouping sends A's two inputs together.
    recordAccountInput('r', replica(A, B), enqueue([payment(B)]));
    recordAccountInput('r', replica(C, B), ackFrame(2, B, C));
    recordAccountInput('r', replica(A, B), ackFrame(3));
    const wave = buildAuthorityWave('r');

    if (wave.kind !== 'wave') throw new Error('expected a wave');
    // Sent as A's group first, so A's composite input is operation 1 even
    // though C's composite input arrived first. Each ack_frame consumes one
    // global arrival and one candidate operation.
    expect(wave.inputs.map(row => row.operationIndex)).toEqual([1, 0]);
    expect(wave.inputs.map(row => row.arrivalIndex)).toEqual([2, 1]);
    expect(wave.inputs.map(row => row.ownerEntityId)).toEqual([A, C]);
    expect(wave.entities.flatMap(entity => entity.operations)).toEqual([
      {
        operationIndex: 0,
        arrivalIndex: 0,
        accountId: B,
        resultKind: 'admission',
        expectedVerdict: { kind: 'admission', admittedCount: 1 },
      },
      {
        operationIndex: 1,
        arrivalIndex: 2,
        accountId: B,
        resultKind: 'applied',
        expectedVerdict: {
          kind: 'input',
          outcome: 'applied',
          committedFrames: [],
          responseAckHanko: null,
          events: [],
        },
      },
      {
        operationIndex: 0,
        arrivalIndex: 1,
        accountId: B,
        resultKind: 'applied',
        expectedVerdict: {
          kind: 'input',
          outcome: 'applied',
          committedFrames: [],
          responseAckHanko: null,
          events: [],
        },
      },
    ]);
    expect(wave.entities.flatMap(entity => entity.operations)
      .sort((left, right) => left.arrivalIndex - right.arrivalIndex)
      .map(row => row.operationIndex)).toEqual([0, 0, 1]);
    const groupedOps = wave.entities.flatMap(entity => entity.ops) as unknown[][];
    expect(groupedOps.map(op => op[0] === 0 ? op[1] : (op[1] as unknown[])[0]))
      .toEqual([0, 1, 0]);
  });

  test('a Hanko that is not hex is refused, never read as zero bytes', () => {
    beginAuthorityFrame('r');
    noteAuthorityEntityClock('r', A, 'enforce', 1_700_000_000_000, 100);
    recordAccountInput('r', replica(A, B), {
      kind: 'ack',
      fromEntityId: B,
      toEntityId: A,
      domain: { chainId: 31_337, depositoryAddress: `0x${'11'.repeat(20)}` },
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 20 },
      ack: { height: 1, frameHash: `0x${'55'.repeat(32)}`, frameHanko: '0xzzzz' },
    });
    const wave = buildAuthorityWave('r');

    expect(wave.kind).toBe('ineligible');
    if (wave.kind !== 'ineligible') throw new Error('expected ineligible');
    expect(wave.reason).toContain('hankoInvalid');
  });
});
