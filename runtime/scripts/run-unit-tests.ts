#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanupTestArtifactsBeforeRun,
  TEST_ARTIFACT_CLEANUP_DONE_ENV,
} from './test-artifact-cleanup';
import { sanitizeChildProcessEnv } from '../server/child-process-env';

const DEFAULT_UNIT_TEST_TARGETS = [
  'runtime/__tests__',
  'tests/unit',
  'tests/frontend',
  'native/__tests__',
];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REQUIRED_CONTRACT_ARTIFACTS = [
  'jurisdictions/artifacts/contracts/Account.sol/Account.json',
  'jurisdictions/artifacts/contracts/EntityProvider.sol/EntityProvider.json',
  'jurisdictions/artifacts/contracts/Depository.sol/Depository.json',
];

// Bun 1.3.x can return empty captured stdout for nested Bun/Node children when
// these subprocess-contract tests run from the package root. The assertions
// themselves remain unchanged; a second Bun test process runs them from the
// runtime directory, where child stdio is captured correctly.
const SUBPROCESS_STDIO_TEST_FILES = [
  'custody-bootstrap.test.ts',
  'debug-disk.test.ts',
  'dev-anvil-stack.test.ts',
  'dev-radapter-keys.test.ts',
  'playwright-global-setup.test.ts',
  'print-dev-links.test.ts',
];

const CLEANUP_ONLY_FLAGS = new Set(['--keep-test-artifacts', '--no-cleanup']);

const rawArgs = process.argv.slice(2);
const passthrough = rawArgs.filter(arg => !CLEANUP_ONLY_FLAGS.has(arg));
const looksLikeExplicitTarget = (arg: string): boolean => (
  !arg.startsWith('-') && (existsSync(arg) || arg.includes('*') || /\.(test|spec)\.[cm]?[tj]sx?$/.test(arg))
);
const explicitTargets = passthrough.some(looksLikeExplicitTarget);
const rootTestArgs = [
  'test',
  ...(explicitTargets
    ? passthrough
    : [
        ...DEFAULT_UNIT_TEST_TARGETS,
        ...passthrough,
        ...SUBPROCESS_STDIO_TEST_FILES.map(file => `--path-ignore-patterns=**/${file}`),
      ]),
];

cleanupTestArtifactsBeforeRun({
  reason: 'unit-tests',
  argv: rawArgs,
});

const runCommand = async (command: string, args: string[], cwd: string): Promise<number> => {
  const child: ChildProcess = spawn(command, args, {
    cwd,
    env: sanitizeChildProcessEnv({
      ...process.env,
      [TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1',
    }),
    stdio: 'inherit',
  });
  return await new Promise<number>((resolveExit) => {
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      resolveExit(typeof code === 'number' ? code : signal ? 1 : 0);
    });
  });
};

const ensureContractArtifacts = async (): Promise<void> => {
  const missing = REQUIRED_CONTRACT_ARTIFACTS.filter((path) => !existsSync(resolve(ROOT, path)));
  if (missing.length === 0) return;
  console.log(`[unit-tests] compiling missing contract artifacts: ${missing.join(', ')}`);
  const exitCode = await runCommand('bash', ['scripts/sync-contract-artifacts.sh'], ROOT);
  if (exitCode !== 0) throw new Error(`UNIT_CONTRACT_ARTIFACT_COMPILE_FAILED:${exitCode}`);
  const stillMissing = REQUIRED_CONTRACT_ARTIFACTS.filter((path) => !existsSync(resolve(ROOT, path)));
  if (stillMissing.length > 0) {
    throw new Error(`UNIT_CONTRACT_ARTIFACT_MISSING_AFTER_COMPILE:${stillMissing.join(',')}`);
  }
};

const runTests = async (args: string[], cwd: string): Promise<number> => (
  await runCommand('bun', args, cwd)
);

await ensureContractArtifacts();

const rootExitCode = await runTests(rootTestArgs, ROOT);
if (rootExitCode !== 0 || explicitTargets) process.exit(rootExitCode);

const subprocessExitCode = await runTests(
  ['test', ...SUBPROCESS_STDIO_TEST_FILES.map(file => `__tests__/${file}`), ...passthrough],
  resolve(ROOT, 'runtime'),
);

process.exit(subprocessExitCode);
