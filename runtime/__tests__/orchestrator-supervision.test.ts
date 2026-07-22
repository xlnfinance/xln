import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, test } from 'bun:test';
import type { spawn } from 'node:child_process';

import {
  killManagedProcessIds,
  readManagedProcessTable,
  type ManagedProcessOps,
} from '../orchestrator/managed-runtime-leases';
import { closeRelayClientsForReset } from '../relay/reset';
import { createRelayStore } from '../relay/store';

const fakePsChild = () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
};

test('managed process discovery fails closed on spawn error and non-zero exit', async () => {
  const spawnFailed = fakePsChild();
  const spawnFailure = readManagedProcessTable((() => spawnFailed) as unknown as typeof spawn);
  spawnFailed.emit('error', new Error('spawn denied'));
  await expect(spawnFailure).rejects.toThrow('MANAGED_PROCESS_TABLE_SPAWN_FAILED:spawn denied');

  const exited = fakePsChild();
  const exitFailure = readManagedProcessTable((() => exited) as unknown as typeof spawn);
  exited.stderr.end('ps unavailable');
  exited.emit('close', 2, null);
  await expect(exitFailure).rejects.toThrow(
    'MANAGED_PROCESS_TABLE_EXIT_FAILED:code=2:signal=:stderr=ps unavailable',
  );
});

test('managed stale process termination verifies the PID after SIGKILL', async () => {
  let alive = true;
  const signals: Array<NodeJS.Signals | 0> = [];
  const ops: ManagedProcessOps = {
    kill: (_pid, signal) => {
      signals.push(signal);
      if (signal === 0 && !alive) {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      if (signal === 'SIGKILL') alive = false;
      return true;
    },
    sleep: async () => {},
  };

  await killManagedProcessIds([1234], 'test child', ops);
  expect(signals).toEqual(['SIGTERM', 0, 'SIGKILL', 0]);
});

test('managed stale process termination throws if the PID survives SIGKILL', async () => {
  const ops: ManagedProcessOps = {
    kill: () => true,
    sleep: async () => {},
  };
  await expect(killManagedProcessIds([4321], 'stuck child', ops)).rejects.toThrow(
    'MANAGED_RUNTIME_PROCESS_TERMINATION_FAILED:stuck child:pids=4321',
  );
});

test('relay reset force-terminates a socket when graceful close throws', () => {
  const store = createRelayStore('reset-test');
  let terminated = 0;
  store.clients.set('runtime-a', {
    runtimeId: 'runtime-a',
    lastSeen: 0,
    topics: new Set(),
    ws: {
      send: () => {},
      close: () => { throw new Error('close failed'); },
      terminate: () => { terminated += 1; },
    },
  });

  closeRelayClientsForReset(store, { warn: () => {} });
  expect(terminated).toBe(1);
  expect(store.clients.size).toBe(0);
});

test('relay reset retains and reports a socket that cannot be terminated', () => {
  const store = createRelayStore('reset-test');
  store.clients.set('runtime-b', {
    runtimeId: 'runtime-b',
    lastSeen: 0,
    topics: new Set(),
    ws: {
      send: () => {},
      close: () => { throw new Error('close failed'); },
      terminate: () => { throw new Error('terminate failed'); },
    },
  });

  expect(() => closeRelayClientsForReset(store, { warn: () => {} }))
    .toThrow('RELAY_RESET_CLIENT_CLOSE_FAILED:runtime-b');
  expect(store.clients.has('runtime-b')).toBe(true);
});
