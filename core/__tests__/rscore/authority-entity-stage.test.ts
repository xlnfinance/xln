import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  assertAuthorityStageProposalParity,
  assertAuthorityStageVerdictParity,
  deriveAuthorityEntityStageKey,
} from '../../rscore/authority-driver';
import {
  beginAuthorityFrame,
  buildAuthorityWave,
  flushAuthorityFrame,
  noteAuthorityAccountInputResult,
  noteAuthorityAccountProposal,
  noteAuthorityAccountProposalResult,
  noteAuthorityEntityClock,
  noteRawAccountInput,
  resetAuthorityRecordForTests,
  runAuthorityFrameScope,
  type AuthorityWave,
  type AuthorityWaveOperation,
} from '../../rscore/authority-wave';
import type { AccountFrame, AccountInput, AccountReplica } from '../../types/account';
import type { RoutedEntityInput } from '../../runtime/types';
import type { Wave } from '../../rscore/wave-decode';
import { proposeAccountFrameIdle } from '../../account/consensus/result';
import { atomicPairInputsMatch } from '../../runtime/admit/entity-input-atomic';

const RUNTIME = `0x${'11'.repeat(20)}`;
const OWNER_A = `0x${'aa'.repeat(32)}`;
const OWNER_B = `0x${'bb'.repeat(32)}`;
const PEER = `0x${'cc'.repeat(32)}`;

const input = (owner = OWNER_A): RoutedEntityInput => ({
  entityId: owner,
  signerId: '1',
  entityTxs: [],
});

const replica = (owner: string): AccountReplica => ({
  proofHeader: { fromEntity: owner, toEntity: PEER, nextProofNonce: 1 },
} as AccountReplica);

const enqueue: AccountInput = { kind: 'enqueue', txs: [] };

const recordEnqueue = (frameId: string, account: AccountReplica): void => {
  const recorded = noteRawAccountInput(frameId, account, enqueue);
  noteAuthorityAccountInputResult(recorded, {
    ok: true,
    events: [],
    admittedAccountTxCount: 0,
  });
};

const frame = (height: number, stateByte: string): AccountFrame => ({
  height,
  timestamp: 100,
  jHeight: 5,
  accountTxs: [],
  prevFrameHash: height === 1 ? 'genesis' : `0x${'01'.repeat(32)}`,
  accountStateRoot: `0x${'02'.repeat(32)}`,
  stateHash: `0x${stateByte.repeat(32)}`,
  byLeft: true,
  deltas: [],
});

let previousAuthority: string | undefined;
let previousRecord: string | undefined;

beforeEach(() => {
  previousAuthority = process.env['XLN_RSCORE_AUTHORITY'];
  previousRecord = process.env['XLN_RSCORE_AUTHORITY_RECORD'];
  delete process.env['XLN_RSCORE_AUTHORITY'];
  process.env['XLN_RSCORE_AUTHORITY_RECORD'] = '1';
  resetAuthorityRecordForTests();
});

afterEach(() => {
  resetAuthorityRecordForTests();
  if (previousAuthority === undefined) delete process.env['XLN_RSCORE_AUTHORITY'];
  else process.env['XLN_RSCORE_AUTHORITY'] = previousAuthority;
  if (previousRecord === undefined) delete process.env['XLN_RSCORE_AUTHORITY_RECORD'];
  else process.env['XLN_RSCORE_AUTHORITY_RECORD'] = previousRecord;
});

describe('per-Entity authority stage identity', () => {
  test('the key is deterministic and binds ordinal plus every execution lane option', () => {
    const canonical = input();
    const first = deriveAuthorityEntityStageKey(
      RUNTIME,
      OWNER_A,
      7,
      { kind: 'runtime-input', inputIndex: 4 },
      canonical,
      undefined,
      false,
      undefined,
    );
    const same = deriveAuthorityEntityStageKey(
      RUNTIME,
      OWNER_A,
      7,
      { kind: 'runtime-input', inputIndex: 4 },
      { signerId: '1', entityTxs: [], entityId: OWNER_A },
      undefined,
      false,
      undefined,
    );
    expect(first.equals(same)).toBe(true);
    expect(first.equals(deriveAuthorityEntityStageKey(
      RUNTIME,
      OWNER_A,
      8,
      { kind: 'runtime-input', inputIndex: 4 },
      canonical,
      undefined,
      false,
      undefined,
    ))).toBe(false);
    expect(() => deriveAuthorityEntityStageKey(
      RUNTIME,
      OWNER_A,
      7,
      { kind: 'runtime-input', inputIndex: -1 },
      canonical,
      undefined,
      false,
      undefined,
    )).toThrow('RSCORE_AUTHORITY_STAGE_OCCURRENCE:-1');
    expect(first.equals(deriveAuthorityEntityStageKey(
      RUNTIME,
      OWNER_A,
      7,
      { kind: 'runtime-input', inputIndex: 4 },
      canonical,
      'account-work',
      false,
      undefined,
    ))).toBe(false);
    expect(first.equals(deriveAuthorityEntityStageKey(
      RUNTIME,
      OWNER_A,
      7,
      { kind: 'runtime-input', inputIndex: 4 },
      canonical,
      undefined,
      true,
      0,
    ))).toBe(false);
    expect(first.equals(deriveAuthorityEntityStageKey(
      RUNTIME,
      OWNER_A,
      7,
      { kind: 'runtime-input', inputIndex: 5 },
      canonical,
      undefined,
      false,
      undefined,
    ))).toBe(false);
    expect(first.equals(deriveAuthorityEntityStageKey(
      RUNTIME,
      OWNER_A,
      7,
      { kind: 'local-event', ordinal: 4 },
      canonical,
      undefined,
      false,
      undefined,
    ))).toBe(false);
  });

  test('nested collection restores the outer scope and records an exact zero-op proposal', async () => {
    const env: { accountAuthorityFrameId?: string | null } = {
      accountAuthorityFrameId: 'outer',
    };
    beginAuthorityFrame('outer');
    let nested: AuthorityWave = { kind: 'empty' };
    await runAuthorityFrameScope(env, RUNTIME, true, async frameId => {
      if (frameId === null) throw new Error('TEST_ENTITY_STAGE_FRAME_MISSING');
      const proposal = noteAuthorityAccountProposal(frameId, OWNER_A, PEER, 100, 5);
      noteAuthorityAccountProposalResult(proposal, proposeAccountFrameIdle({
        message: 'test idle',
        events: [],
        proposalDroppedTransactions: [],
      }));
      nested = buildAuthorityWave(frameId, {
        fallbackEntity: {
          ownerEntityId: OWNER_A,
          timestamp: 99,
          finalizedJHeight: 4,
        },
      });
    });
    expect(env.accountAuthorityFrameId).toBe('outer');
    expect(nested.kind).toBe('wave');
    if (nested.kind !== 'wave') throw new Error('TEST_NESTED_WAVE_MISSING');
    expect(nested.entities[0]?.proposalAccountIds).toEqual([PEER]);
    expect(nested.entities[0]?.ops).toEqual([]);

    noteAuthorityEntityClock('outer', OWNER_A, 'enforce', 101, 6);
    recordEnqueue('outer', replica(OWNER_A));
    const outer = buildAuthorityWave('outer');
    expect(outer.kind).toBe('wave');
    if (outer.kind !== 'wave') throw new Error('TEST_OUTER_WAVE_MISSING');
    expect(outer.entities[0]?.operations).toHaveLength(1);
    expect(outer.entities[0]?.proposalAccountIds).toEqual([]);
    flushAuthorityFrame('outer');
  });

  test('operation indices are candidate-local while arrival order spans owners', () => {
    beginAuthorityFrame('multi');
    noteAuthorityEntityClock('multi', OWNER_A, 'enforce', 100, 5);
    noteAuthorityEntityClock('multi', OWNER_B, 'enforce', 100, 5);
    recordEnqueue('multi', replica(OWNER_A));
    recordEnqueue('multi', replica(OWNER_B));
    const wave = buildAuthorityWave('multi');
    expect(wave.kind).toBe('wave');
    if (wave.kind !== 'wave') throw new Error('TEST_MULTI_WAVE_MISSING');
    expect(wave.entities.map(entity => entity.operations[0]?.operationIndex)).toEqual([0, 0]);
    expect(wave.entities.map(entity => entity.operations[0]?.arrivalIndex)).toEqual([0, 1]);
  });

  test('proposal parity preserves observed order and exact dropped rows', () => {
    const dropped = [{
      index: 0,
      txDigest: `0x${'05'.repeat(32)}`,
      code: 'ACCOUNT_TX_VALIDATION',
      message: 'bad tx',
      disposition: 'removed' as const,
    }];
    const expected = [
      { accountId: PEER, outcome: 'idle' as const, frame: null, dropped },
      { accountId: OWNER_B, outcome: 'idle' as const, frame: null, dropped: [] },
    ];
    const actual = { proposals: [
      { accountId: PEER, frame: null, dropped },
      { accountId: OWNER_B, frame: null, dropped: [] },
    ] };
    expect(() => assertAuthorityStageProposalParity(
      OWNER_A,
      Uint8Array.from({ length: 32 }, () => 6),
      expected,
      actual,
    )).not.toThrow();
    expect(() => assertAuthorityStageProposalParity(
      OWNER_A,
      Uint8Array.from({ length: 32 }, () => 6),
      expected,
      { proposals: [...actual.proposals].reverse() },
    )).toThrow('RSCORE_AUTHORITY_HALT:ENTITY_STAGE_PROPOSAL_VERDICT_MISMATCH');
  });

  test('authority-off preserves ordinary same-Entity atomic routing', () => {
    const marker = { phase: 'proposal' as const, pairKey: 'same-owner' };
    const first = { ...input(), atomicCrossJurisdictionPair: marker };
    const second = { ...input(), atomicCrossJurisdictionPair: marker };
    expect(atomicPairInputsMatch(first, second)).toBe(false);
  });

  test('ordered per-operation parity binds admission and every peer terminal', () => {
    const ackFrame = frame(1, '03');
    const nextFrame = frame(2, '04');
    const operation = (
      operationIndex: number,
      expectedVerdict: AuthorityWaveOperation['expectedVerdict'],
    ): AuthorityWaveOperation => ({
      operationIndex,
      arrivalIndex: operationIndex,
      accountId: PEER,
      resultKind: expectedVerdict.kind === 'admission' ? 'admission' : 'applied',
      expectedVerdict,
    });
    const operations: AuthorityWaveOperation[] = [
      operation(0, { kind: 'admission', admittedCount: 2 }),
      operation(1, {
        kind: 'peer',
        outcome: 'applied',
        committedFrames: [],
        responseAckHanko: null,
      }),
      operation(2, {
        kind: 'peer',
        outcome: 'rejected',
        committedFrames: [],
        responseAckHanko: null,
      }),
      operation(3, {
        kind: 'peer',
        outcome: 'applied',
        committedFrames: [
          { frame: ackFrame, committedViaNewFrame: false },
          { frame: nextFrame, committedViaNewFrame: true },
        ],
        responseAckHanko: '0x1234',
      }),
    ];
    const result: Pick<Wave, 'admissions' | 'applied'> = {
      admissions: [{
        operationIndex: 0,
        accountId: PEER,
        verdict: { kind: 'admitted', count: 2 },
      }],
      applied: [
        { operationIndex: 1, accountId: PEER, verdict: { kind: 'ackStale', height: 0 } },
        { operationIndex: 2, accountId: PEER, verdict: { kind: 'ackRejected', reason: 'bad' } },
        {
          operationIndex: 3,
          accountId: PEER,
          verdict: {
            kind: 'frameAckApplied',
            ackVerdict: {
              kind: 'ackCommitted',
              height: 1,
              stateHash: ackFrame.stateHash,
              outputs: [],
              committedFrame: { frame: ackFrame, committedViaNewFrame: false },
            },
            frameVerdict: {
              kind: 'frameCommitted',
              height: 2,
              stateHash: nextFrame.stateHash,
              ackHanko: '0x1234',
              outputs: [],
              rolledBackTxs: 0,
              committedFrame: { frame: nextFrame, committedViaNewFrame: true },
            },
          },
        },
      ],
    };
    expect(() => assertAuthorityStageVerdictParity(
      OWNER_A,
      Buffer.alloc(32, 9),
      operations,
      result,
    )).not.toThrow();

    const dispute = operation(2, {
      kind: 'peer',
      outcome: 'dispute',
      committedFrames: [],
      responseAckHanko: null,
    });
    expect(() => assertAuthorityStageVerdictParity(
      OWNER_A,
      Buffer.alloc(32, 9),
      [dispute],
      result,
    )).toThrow('RSCORE_AUTHORITY_HALT:ENTITY_STAGE_PEER_VERDICT_MISMATCH');

    const reversed = operation(3, {
      kind: 'peer',
      outcome: 'applied',
      committedFrames: [
        { frame: nextFrame, committedViaNewFrame: true },
        { frame: ackFrame, committedViaNewFrame: false },
      ],
      responseAckHanko: '0x1234',
    });
    expect(() => assertAuthorityStageVerdictParity(
      OWNER_A,
      Buffer.alloc(32, 9),
      [reversed],
      result,
    )).toThrow('RSCORE_AUTHORITY_HALT:ENTITY_STAGE_PEER_VERDICT_MISMATCH');
  });
});
