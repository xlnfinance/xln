#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';

const CORE_E2E_FILES = [
  'tests/e2e-payment-smoke.spec.ts',
  'tests/e2e-dispute.spec.ts',
  'tests/e2e-swap-isolated.spec.ts',
  'tests/e2e-ahb-isolated.spec.ts',
  'tests/e2e-cross-j-swap.spec.ts',
  'tests/e2e-pay-deeplink.spec.ts',
];

const CORE_E2E_TITLES = [
  'fresh runtimes can open accounts, faucet, pay, and reload persisted state',
  'entity workspace dispute lifecycle returns reserve',
  'entity settle workspace Sign & Broadcast submits dispute batch',
  'two isolated users trade against each other through one hub orderbook without market maker liquidity',
  'swap round-trip both directions clears holds and updates closed history on both peers',
  'bidirectional payments survive across two isolated browser contexts',
  'two users can place full, partial, and disputed cross-j swaps through the shared swap builder',
  'restores runtime and opens the pay screen from hash params',
];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const passthrough = process.argv.slice(2);
const runnerArgs = [
  'runtime/scripts/run-e2e-parallel-isolated.ts',
  ...passthrough,
  '--shards=4',
  '--workers-per-shard=1',
  '--max-mm-concurrency=2',
  '--video=off',
  '--trace=off',
  '--screenshot=only-on-failure',
  '--max-failures=1',
  '--pw-project=chromium',
  `--pw-files=${CORE_E2E_FILES.join(',')}`,
  `--pw-grep=${CORE_E2E_TITLES.map(escapeRegExp).join('|')}`,
];

console.log('Core E2E gate:');
for (const title of CORE_E2E_TITLES) console.log(` - ${title}`);

const proc: ChildProcess = spawn('bun', runnerArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

const exitCode = await new Promise<number>((resolve) => {
  proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (typeof code === 'number') {
      resolve(code);
      return;
    }
    resolve(signal ? 1 : 0);
  });
});

process.exit(exitCode);
