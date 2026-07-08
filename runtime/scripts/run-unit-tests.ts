#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

import {
  cleanupTestArtifactsBeforeRun,
  TEST_ARTIFACT_CLEANUP_DONE_ENV,
} from './test-artifact-cleanup';

const DEFAULT_UNIT_TEST_TARGETS = [
  'runtime/__tests__',
  'tests/unit',
  'tests/frontend',
  'native/__tests__',
];

const CLEANUP_ONLY_FLAGS = new Set(['--keep-test-artifacts', '--no-cleanup']);

const rawArgs = process.argv.slice(2);
const passthrough = rawArgs.filter(arg => !CLEANUP_ONLY_FLAGS.has(arg));
const looksLikeExplicitTarget = (arg: string): boolean => (
  !arg.startsWith('-') && (existsSync(arg) || arg.includes('*') || /\.(test|spec)\.[cm]?[tj]sx?$/.test(arg))
);
const explicitTargets = passthrough.some(looksLikeExplicitTarget);
const testArgs = ['test', ...(explicitTargets ? passthrough : [...DEFAULT_UNIT_TEST_TARGETS, ...passthrough])];

cleanupTestArtifactsBeforeRun({
  reason: 'unit-tests',
  argv: rawArgs,
});

const child: ChildProcess = spawn('bun', testArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    [TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1',
  },
  stdio: 'inherit',
});

const exitCode = await new Promise<number>((resolve) => {
  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (typeof code === 'number') {
      resolve(code);
      return;
    }
    resolve(signal ? 1 : 0);
  });
});

process.exit(exitCode);
