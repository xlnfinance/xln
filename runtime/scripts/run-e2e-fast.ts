#!/usr/bin/env bun

import { spawn } from 'node:child_process';

const FAST_E2E_TARGETS = [
  {
    file: 'tests/e2e-payment-smoke.spec.ts',
    title: 'fresh runtimes can open accounts, faucet, pay, and reload persisted state',
  },
  {
    file: 'tests/e2e-radapter-remote.spec.ts',
    title: 'remote /app opens an existing hub runtime through radapter',
  },
  {
    file: 'tests/e2e-pay-deeplink.spec.ts',
    title: 'restores runtime and opens the pay screen from hash params',
  },
  {
    file: 'tests/e2e-active-tab-lock.spec.ts',
    title: 'second /app tab takes ownership and first becomes inactive',
  },
  {
    file: 'tests/e2e-ahb-isolated.spec.ts',
    title: 'bidirectional payments survive across two isolated browser contexts',
  },
  {
    file: 'tests/e2e-custody.spec.ts',
    title: 'separate custody daemon credits deposits and withdraws only from credited offchain balance',
  },
  {
    file: 'tests/e2e-lending.spec.ts',
    title: 'funds hub pool, borrows from it, and repays from the Lending tab',
  },
  {
    file: 'tests/e2e-dispute.spec.ts',
    title: 'entity workspace dispute lifecycle returns reserve',
  },
  {
    file: 'tests/e2e-watchtower-recovery.spec.ts',
    title: 'restores a wiped runtime from standalone tower backup',
  },
  {
    file: 'tests/e2e-swap-isolated.spec.ts',
    title: 'two isolated users trade against each other through one hub orderbook without market maker liquidity',
  },
  {
    file: 'tests/e2e-cross-j-swap.spec.ts',
    title: 'two users can place full, partial, and disputed cross-j swaps through the shared swap builder',
  },
];

const fastTargets = FAST_E2E_TARGETS.map((target) => `${target.file}::${target.title}`);
const passthrough = process.argv.slice(2);
const args = [
  'runtime/scripts/run-e2e-parallel-isolated.ts',
  ...passthrough,
  '--shards=16',
  '--workers-per-shard=1',
  '--max-mm-concurrency=2',
  '--max-reset-concurrency=4',
  '--stack-timeout-ms=300000',
  '--pw-project=chromium',
  `--pw-files=${JSON.stringify(fastTargets)}`,
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
