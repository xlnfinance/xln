import { expect, spyOn, test } from 'bun:test';

import {
  clearPendingAuditEvents,
  flushPendingAuditEvents,
  publishEntityCandidateEffects,
  readRuntimeFrameEvents,
} from '../../../runtime/observability/env-events';
import { createEmptyEnv } from '../../../runtime';

test('committed Account effects mark only the current path-keyed state dirty', () => {
  const env = createEmptyEnv('account-commit-storage-mark-seed');
  publishEntityCandidateEffects(env, null, [{
    kind: 'accountFrameCommitted',
    entityId: '0x01',
    counterpartyId: '0x02',
  }]);

  expect([...env.overlay!.values()]).toEqual([{
    family: 'account',
    entityId: '0x01',
    counterpartyId: '0x02',
  }]);
});

test('machine events stay in the durable Runtime WAL without relay duplication', () => {
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
  expect(env.infrastructure?.pendingAuditEvents).toBeUndefined();

  flushPendingAuditEvents(env);

  expect(forwarded).toHaveLength(0);
  expect(env.infrastructure?.pendingAuditEvents).toBeUndefined();
});

test('frame event payloads are detached from producers and readers', () => {
  const env = createEmptyEnv('env-events-detached-payload-seed');
  const data = { nested: { amount: 10 } };
  env.emit('DetachedFact', data);
  data.nested.amount = 20;

  const read = readRuntimeFrameEvents(env);
  expect(read[0]?.data).toEqual({ nested: { amount: 10 } });
  (read[0]!.data!['nested'] as { amount: number }).amount = 30;
  expect(readRuntimeFrameEvents(env)[0]?.data).toEqual({ nested: { amount: 10 } });
});

test('diagnostic info and log messages stay transient while machine events are durable', () => {
  const env = createEmptyEnv('env-events-transient-diagnostics-seed');
  env.state.timestamp = 321;

  env.log('loop narration');
  env.info('network', 'INBOUND_ENTITY_INPUTS', { count: 200 });
  expect(readRuntimeFrameEvents(env)).toHaveLength(0);

  env.emit('HtlcFinalized', { lockId: 'lock-1' });
  expect(readRuntimeFrameEvents(env).map(entry => entry.message)).toEqual(['HtlcFinalized']);
});

test('ordinary machine emits never enter the relay audit buffer', () => {
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
  expect(env.infrastructure?.pendingAuditEvents).toBeUndefined();
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
    payload: { level: 'error', code: 'REB_STEP', entityId: '0x01', frameHeight: 7 },
  };

  expect(env.infrastructure?.pendingAuditEvents).toBeUndefined();
  publishEntityCandidateEffects(env, null, [effect, effect]);
  expect(env.infrastructure?.pendingAuditEvents?.size).toBe(1);
  expect(forwarded).toHaveLength(0);

  flushPendingAuditEvents(env);
  expect(forwarded).toEqual([effect.payload]);
});
