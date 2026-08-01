import { expect, test } from 'bun:test';

import { createRelayStartupMessageGate } from '../api/server/relay-startup-gate';

test('relay startup gate retains only one hello and rejects every other pre-auth frame', async () => {
  let releaseStartup!: () => void;
  const startupBarrier = new Promise<void>(resolve => { releaseStartup = resolve; });
  const gate = createRelayStartupMessageGate();
  const dispatched: string[] = [];
  const rejected: string[] = [];
  const legitimateSocket = {};
  const arbitraryFrameSocket = {};
  const duplicateHelloSocket = {};

  expect(gate.deferHello(
    startupBarrier,
    legitimateSocket,
    'hello',
    () => { dispatched.push('legitimate'); },
    reason => { rejected.push(`legitimate:${reason}`); },
  )).toBe('deferred');

  expect(gate.deferHello(
    startupBarrier,
    arbitraryFrameSocket,
    'entity_inputs',
    () => { dispatched.push('arbitrary'); },
    reason => { rejected.push(`arbitrary:${reason}`); },
  )).toBe('rejected');

  expect(gate.deferHello(
    startupBarrier,
    duplicateHelloSocket,
    'hello',
    () => { dispatched.push('duplicate'); },
    reason => { rejected.push(`duplicate-first:${reason}`); },
  )).toBe('deferred');
  expect(gate.deferHello(
    startupBarrier,
    duplicateHelloSocket,
    'hello',
    () => { dispatched.push('duplicate-second'); },
    reason => { rejected.push(`duplicate-second:${reason}`); },
  )).toBe('rejected');

  expect(dispatched).toEqual([]);
  expect(gate.pendingCount()).toBe(1);
  expect(rejected).toEqual([
    'arbitrary:startup-hello-required',
    'duplicate-second:startup-hello-pending',
  ]);

  releaseStartup();
  await startupBarrier;
  await Promise.resolve();
  expect(dispatched).toEqual(['legitimate']);
  expect(gate.pendingCount()).toBe(0);
});

test('closing a startup socket cancels its deferred hello', async () => {
  let releaseStartup!: () => void;
  const startupBarrier = new Promise<void>(resolve => { releaseStartup = resolve; });
  const gate = createRelayStartupMessageGate();
  const ws = {};
  let dispatched = false;

  gate.deferHello(
    startupBarrier,
    ws,
    'hello',
    () => { dispatched = true; },
    () => undefined,
  );
  gate.forget(ws);
  releaseStartup();
  await startupBarrier;
  await Promise.resolve();

  expect(dispatched).toBe(false);
  expect(gate.pendingCount()).toBe(0);
});

test('relay startup gate caps pending hellos without retaining closed-socket churn', async () => {
  let releaseStartup!: () => void;
  const startupBarrier = new Promise<void>(resolve => { releaseStartup = resolve; });
  const gate = createRelayStartupMessageGate(2);
  const dispatched: number[] = [];
  const rejected: string[] = [];

  for (let index = 0; index < 100; index += 1) {
    const ws = {};
    gate.deferHello(
      startupBarrier,
      ws,
      'hello',
      () => { dispatched.push(index); },
      reason => { rejected.push(reason); },
    );
    if (index < 99) gate.forget(ws);
  }

  expect(gate.pendingCount()).toBe(1);
  expect(rejected).toEqual([]);
  const second = {};
  const overCapacity = {};
  expect(gate.deferHello(startupBarrier, second, 'hello', () => { dispatched.push(100); }, reason => {
    rejected.push(reason);
  })).toBe('deferred');
  expect(gate.deferHello(startupBarrier, overCapacity, 'hello', () => { dispatched.push(101); }, reason => {
    rejected.push(reason);
  })).toBe('rejected');
  expect(gate.pendingCount()).toBe(2);
  expect(rejected).toEqual(['startup-hello-capacity']);

  releaseStartup();
  await startupBarrier;
  await Promise.resolve();
  expect(dispatched).toEqual([99, 100]);
  expect(gate.pendingCount()).toBe(0);
});
