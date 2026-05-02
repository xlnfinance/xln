#!/usr/bin/env bun

import { spawn } from 'node:child_process';

const FAST_E2E_TARGETS = [
  'tests/e2e-payment-smoke.spec.ts:222',
  'tests/e2e-radapter-remote.spec.ts:25',
  'tests/e2e-pay-deeplink.spec.ts:26',
  'tests/e2e-active-tab-lock.spec.ts:28',
  'tests/e2e-ahb-isolated.spec.ts:684',
  'tests/e2e-custody.spec.ts:885',
  'tests/e2e-dispute.spec.ts:1206',
  'tests/e2e-swap-isolated.spec.ts:958',
];

const passthrough = process.argv.slice(2);
const args = [
  'runtime/scripts/run-e2e-parallel-isolated.ts',
  ...passthrough,
  '--shards=8',
  '--workers-per-shard=1',
  '--max-mm-concurrency=2',
  '--pw-project=chromium',
  `--pw-files=${FAST_E2E_TARGETS.join(',')}`,
  '--video=off',
  '--trace=off',
  '--screenshot=only-on-failure',
  '--max-failures=1',
];

const child = spawn('bun', args, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
