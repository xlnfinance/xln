import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, test } from 'bun:test';
import type { spawn } from 'node:child_process';

import {
  createManagedRuntimeLeaseManager,
  killManagedProcessIds,
  managedLeaseMatchesProcessBirth,
  parseManagedProcessTable,
  readManagedProcessTable,
  type ManagedProcessOps,
} from '../../../orchestrator/process/managed-runtime-leases';
import type { ManagedRuntimeSpec } from '../../../orchestrator/orchestrator-types';
import { closeRelayClientsForReset } from '../../../network/relay/reset';
import { createRelayStore } from '../../../network/relay/store';
import { safeStringify } from '../../../protocol/serialization';

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

test('managed process table binds a PID to its OS birth time', () => {
  const entries = parseManagedProcessTable(
    '  4321 Wed Jul 22 07:55:36 2026 bun core/orchestrator/hub-node.ts --name H1\n',
  );
  expect(entries).toHaveLength(1);
  expect(entries[0]?.pid).toBe(4321);
  expect(entries[0]?.command).toContain('hub-node.ts');
  expect(entries[0]?.processStartedAt).toBe(Date.parse('Wed Jul 22 07:55:36 2026'));
  expect(() => parseManagedProcessTable('4321 malformed-row')).toThrow('MANAGED_PROCESS_TABLE_ROW_INVALID');

  const lease = { pid: 4321, processStartedAt: entries[0]!.processStartedAt };
  expect(managedLeaseMatchesProcessBirth(lease, entries[0]!)).toBe(true);
  expect(managedLeaseMatchesProcessBirth(lease, {
    ...entries[0]!,
    processStartedAt: entries[0]!.processStartedAt + 1_000,
  })).toBe(false);
});

test('malformed persisted runtime lease fails closed instead of being ignored', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-managed-lease-invalid-'));
  const spec: ManagedRuntimeSpec = {
    role: 'hub', name: 'H1', script: 'core/orchestrator/hub-node.ts', apiPort: 21001, dbPath: '/tmp/h1',
  };
  try {
    const manager = createManagedRuntimeLeaseManager({ controlPlaneDir: directory, ownerId: 'owner' });
    writeFileSync(manager.leasePathFor(spec), safeStringify({
      role: 'hub', name: 'H1', script: 'core/orchestrator/hub-node.ts', apiPort: 21001, dbPath: '/tmp/h1',
      ownerId: 'owner', orchestratorPid: 1, pid: 2, cwd: '/tmp', startedAt: 1, processStartedAt: 1, updatedAt: 1,
      unexpected: true,
    }));
    expect(() => manager.readLease(spec)).toThrow('MANAGED_RUNTIME_LEASE_INVALID');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('managed lease accepts the canonical native H1 executable identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-managed-rust-h1-'));
  const spec: ManagedRuntimeSpec = {
    role: 'hub', name: 'H1', script: 'rscore/target/release/xlnrs',
    apiPort: 21001, dbPath: '/tmp/h1',
  };
  try {
    const manager = createManagedRuntimeLeaseManager({ controlPlaneDir: directory, ownerId: 'owner' });
    writeFileSync(manager.leasePathFor(spec), safeStringify({
      ...spec, ownerId: 'owner', orchestratorPid: 1, pid: 2, cwd: '/tmp',
      startedAt: 1, processStartedAt: 1, updatedAt: 1,
    }));
    expect(manager.readLease(spec)?.script).toBe('rscore/target/release/xlnrs');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
