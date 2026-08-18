import { expect, spyOn, test } from 'bun:test';

import {
  clearPendingAuditEvents,
  flushPendingAuditEvents,
  publishEntityCandidateEffects,
  readRuntimeFrameEvents,
} from '../../../runtime/observability/env-events';
import { createEmptyEnv } from '../../../runtime';

test('every machine event reaches history only after commit flush', () => {
  const env = createEmptyEnv('env-events-audit-commit-seed');
  const forwarded: Array<Record<string, unknown>> = [];
  env.infrastructure!.p2p = {
    sendDebugEvent: (payload: unknown) => {
      forwarded.push(...((payload as { events: Record<string, unknown>[] }).events));
      return true;
    },
  } as never;

  env.state.timestamp = 123;
  env.emit('OrdinaryCommittedFact', { entityId: '0x01', amount: '10' });

  expect(forwarded).toHaveLength(0);
  expect(readRuntimeFrameEvents(env)).toHaveLength(1);
  expect(env.infrastructure?.pendingAuditEvents?.size).toBe(1);

  flushPendingAuditEvents(env);

  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]?.eventName).toBe('OrdinaryCommittedFact');
  expect(env.infrastructure?.pendingAuditEvents?.size).toBe(0);
});

test('clearing pending audit events drops uncommitted high-signal emits', () => {
  const env = createEmptyEnv('env-events-audit-clear-seed');
  const forwarded: Array<Record<string, unknown>> = [];
  env.infrastructure!.p2p = {
    sendDebugEvent: (payload: unknown) => {
      forwarded.push(...((payload as { events: Record<string, unknown>[] }).events));
      return true;
    },
  } as never;

  env.emit('JEventReceived', { entityId: '0x02', jHeight: 5 });
  clearPendingAuditEvents(env);
  flushPendingAuditEvents(env);

  expect(forwarded).toHaveLength(0);
  expect(env.infrastructure?.pendingAuditEvents?.size).toBe(0);
});

test('warn and error diagnostics cannot escape before WAL commit', () => {
  const env = createEmptyEnv('env-events-structured-log-boundary');
  const forwarded: Array<Record<string, unknown>> = [];
  env.infrastructure!.p2p = {
    sendDebugEvent: (payload: unknown) => {
      forwarded.push(...((payload as { events: Record<string, unknown>[] }).events));
      return true;
    },
  } as never;
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = spyOn(console, 'error').mockImplementation(() => undefined);

  try {
    env.info('account', 'ordinary committed diagnostic', { height: 7 });
    env.warn('account', 'signed proposal is stale');
    env.error('runtime', 'candidate failed');
    expect(forwarded).toEqual([]);
    expect(env.infrastructure?.pendingAuditEvents?.size).toBe(2);

    flushPendingAuditEvents(env);
    expect(forwarded.map(payload => payload.level)).toEqual(['warn', 'error']);
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});

test('candidate notifications remain inert until commit publication and dedupe by exact payload', () => {
  const env = createEmptyEnv('candidate-effect-commit-boundary');
  const forwarded: Array<Record<string, unknown>> = [];
  env.infrastructure!.p2p = {
    sendDebugEvent: (payload: unknown) => {
      forwarded.push(...((payload as { events: Record<string, unknown>[] }).events));
      return true;
    },
  } as never;
  const effect = {
    kind: 'debug' as const,
    payload: { code: 'REB_STEP', entityId: '0x01', frameHeight: 7 },
  };

  expect(env.infrastructure?.pendingAuditEvents).toBeUndefined();
  publishEntityCandidateEffects(env, null, [effect, effect]);
  expect(env.infrastructure?.pendingAuditEvents?.size).toBe(1);
  expect(forwarded).toHaveLength(0);

  flushPendingAuditEvents(env);
  expect(forwarded).toEqual([effect.payload]);
});

test('candidate Account history is idempotent and conflicting bytes fail fast', () => {
  const env = createEmptyEnv('candidate-account-history');
  const frame = {
    height: 1,
    timestamp: 100,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    accountStateRoot: '0x01',
    stateHash: '0x02',
    byLeft: true,
    deltas: [],
  };
  const effect = {
    kind: 'accountFrameHistory' as const,
    entityId: '0x01',
    counterpartyId: '0x02',
    accountHeight: 1,
    source: 'peerCommit' as const,
    frame,
  };

  publishEntityCandidateEffects(env, null, [effect, effect]);
  expect(env.infrastructure?.pendingHistoryRecords).toHaveLength(1);
  publishEntityCandidateEffects(env, null, [{ ...effect, source: 'ackCommit' }]);
  expect(env.infrastructure?.pendingHistoryRecords).toHaveLength(1);
  expect(() => publishEntityCandidateEffects(env, null, [{
    ...effect,
    frame: { ...frame, stateHash: '0x03' },
  }])).toThrow('CERTIFIED_ACCOUNT_FRAME_FORK');
});

test('candidate Account history stores one semantic frame across valid Hanko subsets', () => {
  const env = createEmptyEnv('candidate-account-history-hanko-subsets');
  const frame = {
    height: 1,
    timestamp: 100,
    jHeight: 0,
    accountTxs: [{
      type: 'settle_transition' as const,
      data: {
        kind: 'seal' as const,
        revision: 1,
        workspaceHash: '0xworkspace',
        settlementNonce: 2,
        settlementHash: '0xsettlement',
        settlementHanko: '0xsubset-a',
        postProof: {
          nonce: 3,
          proposerIsLeft: true,
          proofBodyHash: '0xproof',
          disputeHash: '0xdispute',
          hanko: '0xpost-a',
        },
      },
    }],
    prevFrameHash: 'genesis',
    accountStateRoot: '0x01',
    stateHash: '0x02',
    byLeft: true,
    deltas: [],
  };
  const second = structuredClone(frame);
  second.accountTxs[0].data.settlementHanko = '0xsubset-b';
  second.accountTxs[0].data.postProof.hanko = '0xpost-b';
  const base = {
    kind: 'accountFrameHistory' as const,
    entityId: '0x01',
    counterpartyId: '0x02',
    accountHeight: 1,
    source: 'peerCommit' as const,
  };

  publishEntityCandidateEffects(env, null, [{ ...base, frame }, { ...base, frame: second }]);

  const records = env.infrastructure?.pendingHistoryRecords ?? [];
  expect(records).toHaveLength(1);
  const stored = records[0];
  if (stored?.kind !== 'accountFrame') throw new Error('TEST_ACCOUNT_HISTORY_MISSING');
  const storedTx = stored.frame.accountTxs[0];
  if (storedTx?.type !== 'settle_transition' || storedTx.data.kind !== 'seal') {
    throw new Error('TEST_SETTLEMENT_FRAME_MISSING');
  }
  expect(storedTx.data.settlementHanko).toBeUndefined();
  expect(storedTx.data.postProof.hanko).toBeUndefined();
});
