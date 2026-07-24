import { expect, test } from 'bun:test';

import {
  clearPendingAuditEvents,
  flushPendingAuditEvents,
  publishEntityCandidateEffects,
} from '../machine/env-events';
import { createEmptyEnv } from '../runtime';

test('high-signal env.emit reaches debug relay only after commit flush', () => {
  const env = createEmptyEnv('env-events-audit-commit-seed');
  const forwarded: Array<Record<string, unknown>> = [];
  env.runtimeState!.p2p = {
    sendDebugEvent: (payload: unknown) => {
      forwarded.push(payload as Record<string, unknown>);
      return true;
    },
  } as never;

  env.timestamp = 123;
  env.emit('HtlcReceived', { entityId: '0x01', amount: '10' });

  expect(forwarded).toHaveLength(0);
  expect(env.frameLogs).toHaveLength(1);
  expect(env.runtimeState?.pendingAuditEvents).toHaveLength(1);

  flushPendingAuditEvents(env);

  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]?.eventName).toBe('HtlcReceived');
  expect(env.runtimeState?.pendingAuditEvents).toHaveLength(0);
});

test('clearing pending audit events drops uncommitted high-signal emits', () => {
  const env = createEmptyEnv('env-events-audit-clear-seed');
  const forwarded: Array<Record<string, unknown>> = [];
  env.runtimeState!.p2p = {
    sendDebugEvent: (payload: unknown) => {
      forwarded.push(payload as Record<string, unknown>);
      return true;
    },
  } as never;

  env.emit('JEventReceived', { entityId: '0x02', jHeight: 5 });
  clearPendingAuditEvents(env);
  flushPendingAuditEvents(env);

  expect(forwarded).toHaveLength(0);
  expect(env.runtimeState?.pendingAuditEvents).toHaveLength(0);
});

test('candidate notifications remain inert until commit publication and dedupe by exact payload', () => {
  const env = createEmptyEnv('candidate-effect-commit-boundary');
  const forwarded: Array<Record<string, unknown>> = [];
  env.runtimeState!.p2p = {
    sendDebugEvent: (payload: unknown) => {
      forwarded.push(payload as Record<string, unknown>);
      return true;
    },
  } as never;
  const effect = {
    kind: 'debug' as const,
    payload: { code: 'REB_STEP', entityId: '0x01', frameHeight: 7 },
  };

  expect(env.runtimeState?.pendingAuditEvents).toBeUndefined();
  publishEntityCandidateEffects(env, [effect, effect]);
  expect(env.runtimeState?.pendingAuditEvents).toHaveLength(1);
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

  publishEntityCandidateEffects(env, [effect, effect]);
  expect(env.runtimeState?.pendingFrameDbRecords).toHaveLength(1);
  expect(() => publishEntityCandidateEffects(env, [{
    ...effect,
    frame: { ...frame, stateHash: '0x03' },
  }])).toThrow('FRAME_DB_ACCOUNT_FRAME_FORK');
});
