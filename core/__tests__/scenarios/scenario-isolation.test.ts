import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertScenarioRpcOutsideDev,
  buildScenarioIsolatedEnv,
  requireScenarioLeasePort,
  resolveScenarioIsolatedDbRoot,
} from '../../scenarios/harness/scenario-isolation';
import { stripAmbientLocalStackEnv } from '../../scripts/e2e/harness/local-test-port-lease';

test('scenario RPC rejects every reserved dev endpoint', () => {
  expect(() => assertScenarioRpcOutsideDev('http://127.0.0.1:8545'))
    .toThrow('SCENARIO_RPC_USES_DEV_PORT:8545');
  expect(() => assertScenarioRpcOutsideDev('http://localhost:8080'))
    .toThrow('SCENARIO_RPC_USES_DEV_PORT:8080');
  expect(() => assertScenarioRpcOutsideDev('http://127.0.0.1:20000')).not.toThrow();
});

test('scenario port batches expose only offsets from the assigned lease', () => {
  const previous = process.env['XLN_SCENARIO_LEASE_BASE'];
  try {
    process.env['XLN_SCENARIO_LEASE_BASE'] = '20000';
    expect(requireScenarioLeasePort(4)).toBe(20004);
    expect(() => requireScenarioLeasePort(19)).toThrow('SCENARIO_LEASE_PORT_INVALID');
  } finally {
    if (previous === undefined) delete process.env['XLN_SCENARIO_LEASE_BASE'];
    else process.env['XLN_SCENARIO_LEASE_BASE'] = previous;
  }
});

test('cross-j uses the assigned port batch and isolated child databases', () => {
  const parent = readFileSync(join(process.cwd(), 'core/scenarios/cross-j/index.ts'), 'utf8');
  const child = readFileSync(join(process.cwd(), 'core/scenarios/cross-j/node.ts'), 'utf8');
  const p2p = readFileSync(join(process.cwd(), 'core/scenarios/network/p2p-relay.ts'), 'utf8');
  expect(parent).toContain('requireScenarioLeasePort(2)');
  expect(parent).toContain("path.join(scenarioDbRoot, role)");
  expect(parent).not.toContain("path.join(process.cwd(), 'db-tmp')");
  expect(child).not.toContain('reservePort');
  expect(p2p).toContain('acquireLocalTestPortLease({ requiredOffsets: [0]');
  expect(p2p).toContain('buildScenarioIsolatedEnv(process.env, dbPath');
  expect(p2p).not.toContain('getFreePort');
});

test('scenario child environment replaces every ambient storage root', () => {
  const env = buildScenarioIsolatedEnv({
    ANVIL_RPC: 'http://127.0.0.1:8545',
    XLN_DB_PATH: '/repo/db/dev',
    XLN_DEV_DATA_ROOT: '/repo/db/dev',
    XLN_JDB_ROOT: '/repo/db/dev/jdb',
    XLN_MESH_DB_ROOT: '/repo/db/dev/mesh',
    XLN_RDB_ROOT: '/repo/db/dev/rdb',
    XLN_STORAGE_HISTORY_PATH: '/repo/db/dev/history',
  }, '/tmp/xln-scenario-isolated', 'http://127.0.0.1:20000');

  expect(env['ANVIL_RPC']).toBe('http://127.0.0.1:20000');
  expect(env['XLN_DB_PATH']).toBe('/tmp/xln-scenario-isolated');
  expect(env['XLN_RDB_ROOT']).toBe('/tmp/xln-scenario-isolated/rdb');
  expect(env['XLN_JDB_ROOT']).toBe('/tmp/xln-scenario-isolated/jdb');
  expect(env['XLN_MESH_DB_ROOT']).toBe('/tmp/xln-scenario-isolated/mesh');
  expect(env['XLN_STORAGE_HISTORY_PATH']).toBe('/tmp/xln-scenario-isolated/history');
  expect(env['XLN_DEV_DATA_ROOT']).toBeUndefined();
});

test('scenario database root rejects shared and dev storage before creation', () => {
  const repo = process.cwd();
  expect(() => resolveScenarioIsolatedDbRoot(join(repo, 'db', 'dev'), repo))
    .toThrow('SCENARIO_DB_ROOT_OVERLAPS_SHARED');
  expect(() => resolveScenarioIsolatedDbRoot(join(repo, 'db', 'scenario'), repo))
    .toThrow('SCENARIO_DB_ROOT_OVERLAPS_SHARED');
  expect(() => resolveScenarioIsolatedDbRoot(join(repo, '.logs', 'dev', 'scenario'), repo))
    .toThrow('SCENARIO_DB_ROOT_OVERLAPS_SHARED');
  expect(resolveScenarioIsolatedDbRoot('/tmp/xln-scenario-isolated-db', repo))
    .toBe('/tmp/xln-scenario-isolated-db');
});

test('HLT child environment drops ambient dev ports and roots before leased values are assigned', () => {
  const smoke = readFileSync(
    join(process.cwd(), 'core/scripts/operations/production/local-prod-smoke.ts'),
    'utf8',
  );
  const env = stripAmbientLocalStackEnv({
    ANVIL_PORT: '8545',
    ANVIL2_PORT: '8546',
    ANVIL_RPC2: 'http://127.0.0.1:8546',
    RPC_TRON: 'http://127.0.0.1:8546',
    XLN_DB_PATH: '/repo/db/dev',
    XLN_RDB_ROOT: '/repo/db/dev/rdb',
    XLN_DEV_LAUNCHER_PORT: '17999',
    XLN_HLT_USERS: '1000',
  });
  expect(env['ANVIL_PORT']).toBeUndefined();
  expect(env['ANVIL2_PORT']).toBeUndefined();
  expect(env['ANVIL_RPC2']).toBeUndefined();
  expect(env['RPC_TRON']).toBeUndefined();
  expect(env['XLN_DB_PATH']).toBeUndefined();
  expect(env['XLN_RDB_ROOT']).toBeUndefined();
  expect(env['XLN_DEV_LAUNCHER_PORT']).toBeUndefined();
  expect(env['XLN_HLT_USERS']).toBe('1000');

  const leased = { ...env, XLN_PORT_BASE: '20000', XLN_DB_PATH: '/tmp/xln-hlt/prod-main' };
  expect(leased['XLN_PORT_BASE']).toBe('20000');
  expect(leased['XLN_DB_PATH']).toBe('/tmp/xln-hlt/prod-main');
  expect(smoke).toContain('XLN_PORT_BASE: String(portBase)');
  expect(smoke).toContain("XLN_JDB_ROOT: join(workDir, 'jdb')");
  expect(smoke).toContain("ANVIL_TMPDIR: join(workDir, 'server-anvil-tmp')");
});
