import { expect, test } from 'bun:test';

import { clearPendingAuditEvents, flushPendingAuditEvents } from '../env-events';
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
