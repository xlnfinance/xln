#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  cleanupTestArtifactsBeforeRun,
  TEST_ARTIFACT_CLEANUP_DONE_ENV,
} from './test-artifact-cleanup';
import { sanitizeChildProcessEnv } from '../child-process-env';

const DEFAULT_UNIT_TEST_TARGETS = [
  'runtime/__tests__',
  'tests/unit',
  'tests/frontend',
  'native/__tests__',
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

const runTests = async (args: string[], cwd: string): Promise<number> => {
  const child: ChildProcess = spawn('bun', args, {
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

const rootExitCode = await runTests(rootTestArgs, process.cwd());
if (rootExitCode !== 0 || explicitTargets) process.exit(rootExitCode);

const subprocessExitCode = await runTests(
  ['test', ...SUBPROCESS_STDIO_TEST_FILES.map(file => `__tests__/${file}`), ...passthrough],
  resolve(process.cwd(), 'runtime'),
);

process.exit(subprocessExitCode);
