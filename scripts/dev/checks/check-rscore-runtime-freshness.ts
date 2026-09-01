#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { utimesSync } from 'node:fs';

import {
  assertRustHubBinaryFresh,
  RSCORE_RUNTIME_BUILD_COMMAND,
} from '../../../core/orchestrator/process/hub-engine-plan';
import { stopProcessGroup } from '../../../core/scripts/e2e/runners/process-group';

const repositoryRoot = import.meta.dir + '/../../..';
const runtimeBinary = `${repositoryRoot}/rscore/target/release/xlnrs`;
const BUILD_TIMEOUT_MS = 30_000;
const selectedEngine = String(process.env['XLN_HLT_ENGINE'] || 'ts').trim();

const buildNativeH1 = async (): Promise<void> => {
  const command = RSCORE_RUNTIME_BUILD_COMMAND.split(' ');
  const child = spawn(command[0]!, command.slice(1), {
    cwd: repositoryRoot,
    detached: true,
    stdio: 'inherit',
  });
  const pid = child.pid;
  if (!pid) throw new Error('RUST_HUB_BUILD_SPAWN_FAILED');
  let timedOut = false;
  let stopping: Promise<void> | null = null;
  const stopBuild = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = stopProcessGroup({
      pid,
      termTimeoutMs: 500,
      killTimeoutMs: 2_000,
      timeoutError: `RUST_HUB_BUILD_STOP_TIMEOUT:pid=${pid}`,
    });
    return stopping;
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    void stopBuild();
  }, BUILD_TIMEOUT_MS);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  }).finally(() => clearTimeout(timeout));
  await stopBuild();
  if (timedOut) throw new Error(`RUST_HUB_BUILD_TIMEOUT:${BUILD_TIMEOUT_MS}`);
  if (exitCode !== 0) throw new Error(`RUST_HUB_BUILD_FAILED:${exitCode}`);
};

const ensureNativeH1 = async (): Promise<void> => {
  // Cargo's dependency graph is the authority for target freshness. A raw
  // recursive mtime scan also sees unrelated binaries and can demand the same
  // no-op build forever because Cargo correctly leaves fresh output untouched.
  console.log(`[dev] verifying native H1: ${RSCORE_RUNTIME_BUILD_COMMAND}`);
  await buildNativeH1();
  const verifiedAt = new Date();
  utimesSync(runtimeBinary, verifiedAt, verifiedAt);
  const executable = assertRustHubBinaryFresh(repositoryRoot);
  console.log(`[dev] native H1 binary fresh: ${executable}`);
};

if (selectedEngine === 'rust') {
  await ensureNativeH1().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
