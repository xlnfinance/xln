import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isE2ERunnerProcessAlive,
  parseE2ERunnerLock,
  readE2ERunnerLock,
} from '../scripts/e2e-runner-lock';

test('runner lock parser rejects corrupt and incomplete ownership evidence', () => {
  expect(() => parseE2ERunnerLock('{', '/lock')).toThrow('RUNNER_LOCK_INVALID');
  expect(() => parseE2ERunnerLock('{}', '/lock')).toThrow('pid must be a positive safe integer');
  expect(() => parseE2ERunnerLock(JSON.stringify({ pid: 1, startedAt: 1, cwd: '' }), '/lock'))
    .toThrow('cwd is required');
});

test('runner lock reader distinguishes absence from corrupt evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xln-runner-lock-'));
  const path = join(dir, 'runner.json');
  try {
    expect(readE2ERunnerLock(path)).toBeNull();
    writeFileSync(path, '{');
    expect(() => readE2ERunnerLock(path)).toThrow('RUNNER_LOCK_INVALID');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner process probe treats only ESRCH as absent', () => {
  const missing = Object.assign(new Error('missing'), { code: 'ESRCH' });
  const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
  expect(isE2ERunnerProcessAlive(123, () => { throw missing; })).toBe(false);
  expect(() => isE2ERunnerProcessAlive(123, () => { throw denied; }))
    .toThrow('RUNNER_PROCESS_PROBE_FAILED');
});
