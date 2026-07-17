import { expect, test } from 'bun:test';

import {
  runE2EShardFailureDiagnostic,
  signalE2EFatalMonitorChild,
} from '../scripts/run-e2e-parallel-isolated';

test('preserves the primary shard failure and surfaces a forensic capture failure', async () => {
  const reported: string[] = [];
  const primary = 'E2E_ABORTED_AFTER_FIRST_FAILURE';
  const error = await runE2EShardFailureDiagnostic(
    primary,
    'failure-forensics',
    async () => { throw new Error('forensic disk full'); },
    secondary => reported.push(secondary),
  );

  expect(error).toBe(
    `${primary}\nE2E_SHARD_SECONDARY_FAILURE:failure-forensics:Error: forensic disk full`,
  );
  expect(reported).toEqual([
    'E2E_SHARD_SECONDARY_FAILURE:failure-forensics:Error: forensic disk full',
  ]);

  reported.length = 0;
  expect(await runE2EShardFailureDiagnostic(
    primary,
    'failure-forensics',
    async () => undefined,
    secondary => reported.push(secondary),
  )).toBe(primary);
  expect(reported).toEqual([]);
});

test('preserves the fatal marker and surfaces an immediate child signal failure', () => {
  const reported: string[] = [];
  const primary = 'E2E_FATAL_RUNTIME_LOG marker=/RUNTIME_LOOP_HALTED/';
  const error = signalE2EFatalMonitorChild(primary, 'api', {
    exitCode: null,
    pid: 4242,
    kill: () => { throw new Error('signal denied'); },
  }, secondary => reported.push(secondary));

  const secondary =
    'E2E_SHARD_SECONDARY_FAILURE:fatal-monitor-signal:api:pid=4242:Error: signal denied';
  expect(error).toBe(`${primary}\n${secondary}`);
  expect(reported).toEqual([secondary]);

  reported.length = 0;
  expect(signalE2EFatalMonitorChild(primary, 'vite', {
    exitCode: null,
    pid: 4343,
    kill: () => true,
  }, next => reported.push(next))).toBe(primary);
  expect(reported).toEqual([]);
});
