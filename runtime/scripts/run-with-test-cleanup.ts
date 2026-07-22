#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';

import {
  cleanupTestArtifactsBeforeRun,
  TEST_ARTIFACT_CLEANUP_DONE_ENV,
  transferTestArtifactRunLease,
} from './test-artifact-cleanup';
import { sanitizeChildProcessEnv } from '../server/child-process-env';

type CleanupScope = 'all' | 'e2e';

export type ParsedRunWithTestCleanupArgs = {
  reason: string;
  scope: CleanupScope;
  cleanupCwd?: string | undefined;
  childCwd?: string | undefined;
  command: string;
  commandArgs: string[];
  cleanupArgv: string[];
};

const CLEANUP_ONLY_FLAGS = new Set(['--keep-test-artifacts', '--no-cleanup']);
const CHILD_GROUP_STOP_TIMEOUT_MS = 5_000;
const WRAPPER_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

const signalProcessGroup = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

const processGroupIsAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

const waitForProcessGroupExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupIsAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return !processGroupIsAlive(pid);
};

export const stopChildProcessGroup = async (
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<void> => {
  if (!signalProcessGroup(pid, signal)) return;
  if (await waitForProcessGroupExit(pid, CHILD_GROUP_STOP_TIMEOUT_MS)) return;
  signalProcessGroup(pid, 'SIGKILL');
  if (await waitForProcessGroupExit(pid, CHILD_GROUP_STOP_TIMEOUT_MS)) return;
  throw new Error(`TEST_CLEANUP_CHILD_GROUP_STOP_TIMEOUT:pid=${pid}`);
};

const readOptionValue = (args: string[], index: number, name: string): { value: string; nextIndex: number } => {
  const arg = args[index] || '';
  const inlinePrefix = `--${name}=`;
  if (arg.startsWith(inlinePrefix)) {
    const value = arg.slice(inlinePrefix.length).trim();
    if (!value) throw new Error(`TEST_CLEANUP_RUNNER_EMPTY_OPTION: ${name}`);
    return { value, nextIndex: index };
  }
  if (arg === `--${name}`) {
    const value = String(args[index + 1] || '').trim();
    if (!value || value.startsWith('--')) throw new Error(`TEST_CLEANUP_RUNNER_MISSING_OPTION: ${name}`);
    return { value, nextIndex: index + 1 };
  }
  throw new Error(`TEST_CLEANUP_RUNNER_OPTION_MISMATCH: ${arg}`);
};

const stripCleanupOnlyFlags = (args: string[]): string[] =>
  args.filter((arg) => !CLEANUP_ONLY_FLAGS.has(arg));

export const parseRunWithTestCleanupArgs = (argv: string[]): ParsedRunWithTestCleanupArgs => {
  const separatorIndex = argv.indexOf('--');
  if (separatorIndex < 0) {
    throw new Error('TEST_CLEANUP_RUNNER_USAGE: expected "--" before child command');
  }

  const optionArgs = argv.slice(0, separatorIndex);
  const commandWithArgs = stripCleanupOnlyFlags(argv.slice(separatorIndex + 1));
  const [command, ...commandArgs] = commandWithArgs;
  if (!command) {
    throw new Error('TEST_CLEANUP_RUNNER_USAGE: child command is required');
  }

  let reason = 'test';
  let scope: CleanupScope = 'all';
  let cleanupCwd: string | undefined;
  let childCwd: string | undefined;

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index] || '';
    if (CLEANUP_ONLY_FLAGS.has(arg)) continue;
    if (arg === '--reason' || arg.startsWith('--reason=')) {
      const parsed = readOptionValue(optionArgs, index, 'reason');
      reason = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--scope' || arg.startsWith('--scope=')) {
      const parsed = readOptionValue(optionArgs, index, 'scope');
      if (parsed.value !== 'all' && parsed.value !== 'e2e') {
        throw new Error(`TEST_CLEANUP_RUNNER_INVALID_SCOPE: ${parsed.value}`);
      }
      scope = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--cwd' || arg.startsWith('--cwd=')) {
      const parsed = readOptionValue(optionArgs, index, 'cwd');
      cleanupCwd = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--child-cwd' || arg.startsWith('--child-cwd=')) {
      const parsed = readOptionValue(optionArgs, index, 'child-cwd');
      childCwd = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    throw new Error(`TEST_CLEANUP_RUNNER_UNKNOWN_OPTION: ${arg}`);
  }

  return {
    reason,
    scope,
    cleanupCwd,
    childCwd,
    command,
    commandArgs,
    cleanupArgv: argv,
  };
};

const run = async (): Promise<number> => {
  const parsed = parseRunWithTestCleanupArgs(process.argv.slice(2));
  cleanupTestArtifactsBeforeRun({
    cwd: parsed.cleanupCwd || process.cwd(),
    reason: parsed.reason,
    scope: parsed.scope,
    argv: parsed.cleanupArgv,
  });

  const child: ChildProcess = spawn(parsed.command, parsed.commandArgs, {
    cwd: parsed.childCwd || process.cwd(),
    detached: true,
    env: sanitizeChildProcessEnv({
      ...process.env,
      [TEST_ARTIFACT_CLEANUP_DONE_ENV]: '1',
    }),
    stdio: 'inherit',
  });
  if (!child.pid) {
    child.kill('SIGKILL');
    throw new Error('TEST_ARTIFACT_RUN_LEASE_CHILD_PID_MISSING');
  }
  try {
    transferTestArtifactRunLease(parsed.cleanupCwd || process.cwd(), child.pid);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }

  let wrapperSignal: NodeJS.Signals | null = null;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of WRAPPER_SIGNALS) {
    const handler = (): void => {
      wrapperSignal ??= signal;
      signalProcessGroup(child.pid!, signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    const childResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    await stopChildProcessGroup(child.pid, wrapperSignal ?? 'SIGTERM');
    if (wrapperSignal === 'SIGINT') return 130;
    if (wrapperSignal === 'SIGTERM') return 143;
    if (childResult.signal) return 128;
    return childResult.code ?? 1;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
};

if (import.meta.main) {
  run()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
