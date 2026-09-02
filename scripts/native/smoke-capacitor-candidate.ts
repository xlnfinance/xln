#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  prepareNativeCapacitorCandidate,
  verifyNativeCapacitorCandidateDirectory,
  type NativeCapacitorCandidateResult,
} from './capacitor-candidate';

const CAPACITOR_EXECUTABLE = resolve(import.meta.dir, '../../frontend/node_modules/.bin/cap');

export const smokeNativeCapacitorCandidate = async (
  stagingDirectory: string,
): Promise<NativeCapacitorCandidateResult> => {
  const result = await prepareNativeCapacitorCandidate(stagingDirectory);
  const smoke = spawnSync(CAPACITOR_EXECUTABLE, ['copy', 'web'], {
    cwd: result.workspaceDirectory,
    encoding: 'utf8',
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    shell: false,
  });
  if (smoke.error) throw smoke.error;
  if (smoke.status !== 0) {
    throw new Error(
      `NATIVE_CAPACITOR_CLI_SMOKE_FAILED:${smoke.status ?? 'unknown'}\n${smoke.stdout}${smoke.stderr}`,
    );
  }
  await verifyNativeCapacitorCandidateDirectory(result.workspaceDirectory, stagingDirectory);
  return result;
};

const main = async (): Promise<void> => {
  const args = Bun.argv.slice(2);
  if (args.length !== 1 || !args[0]) throw new Error('NATIVE_CAPACITOR_SMOKE_ARGUMENTS_INVALID');
  const result = await smokeNativeCapacitorCandidate(resolve(args[0]));
  console.info(
    `NATIVE_CAPACITOR_CANDIDATE_OK release=${result.releaseId} status=${result.status} ` +
    `path=${result.workspaceDirectory}`,
  );
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
