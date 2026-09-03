import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AUTHORITY_EVIDENCE_GATE_BUDGET_MS } from '../replay/evidence/gate-support';

const GATE_POLL_MS = 20;
// Economic preparation (swap population, realistic exchange plan, routes) for
// 1,000 users takes ~35-40 s in mixed mode before the child signals ready;
// 30 s aborted every mixed authority run on 2026-09-02.
const PHASE_TIMEOUT_MS = 120_000;
// The live economic window plus its five-second drain and report exceed the
// 30-second process wall at high offered rates. The owner-approved exception
// for the live economic stand under the machine lock is the 180-second budget.
const RUN_PHASE_TIMEOUT_MS = AUTHORITY_EVIDENCE_GATE_BUDGET_MS;
const sleep = (ms: number): Promise<void> => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

const OFFLINE_PARITY_XLN_ALLOWLIST = new Set([
  'XLN_RSCORE_BINARY',
  // The token changes no replay semantics. It proves both bounded stages ran
  // while the outer live authority invocation owned the machine slot.
  'XLN_STAND_LOCK_TOKEN',
]);

/**
 * Offline parity is derived only from its immutable recording and explicit
 * CLI worker counts. Inheriting a future live run's population, engine or
 * workload switches makes the proof depend on the TPS command that invoked
 * it and can multiply its work before the economic child even exists.
 */
export const offlineParityEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) =>
    !name.startsWith('XLN_') || OFFLINE_PARITY_XLN_ALLOWLIST.has(name)));

const gatePid = (path: string, code: string): number => {
  const pid = Number(readFileSync(path, 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(code);
  return pid;
};

const assertFreshGate = (gateDir: string): void => {
  mkdirSync(gateDir, { recursive: true });
  for (const name of ['ready', 'start', 'started', 'abort']) {
    if (existsSync(join(gateDir, name))) throw new Error(`HLT_ECONOMIC_GATE_STALE:${gateDir}`);
  }
};

const waitForGateFile = async (
  path: string,
  child: ChildProcess,
  deadline: number,
  code: string,
): Promise<void> => {
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${code}:CHILD_EXIT:${String(child.exitCode)}:${String(child.signalCode)}`);
    }
    if (Date.now() >= deadline) throw new Error(`${code}:TIMEOUT`);
    await sleep(GATE_POLL_MS);
  }
};

const writeAtomic = (path: string, value: string): void => {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, path);
};

const waitForOwnedChildExit = async (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await sleep(GATE_POLL_MS);
  }
  return child.exitCode !== null || child.signalCode !== null;
};

const runGatedHltChild = async (options: Readonly<{
  gateDir: string;
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}>): Promise<number> => {
  const gateDir = resolve(options.gateDir);
  assertFreshGate(gateDir);
  const child = spawn(options.command, [...options.args], {
    cwd: process.cwd(),
    env: { ...options.env, XLN_HLT_ECONOMIC_GATE_DIR: gateDir },
    stdio: 'inherit',
  });
  const readyPath = join(gateDir, 'ready');
  const startPath = join(gateDir, 'start');
  const startedPath = join(gateDir, 'started');
  const abortPath = join(gateDir, 'abort');
  try {
    await waitForGateFile(
      readyPath, child, Date.now() + PHASE_TIMEOUT_MS, 'HLT_ECONOMIC_GATE_READY',
    );
    const workloadPid = gatePid(readyPath, 'HLT_ECONOMIC_GATE_READY_PID_INVALID');
    if (gatePid(readyPath, 'HLT_ECONOMIC_GATE_READY_PID_INVALID') !== workloadPid) {
      throw new Error('HLT_ECONOMIC_GATE_READY_PID_CHANGED');
    }
    writeAtomic(startPath, 'start\n');
    await waitForGateFile(
      startedPath, child, Date.now() + PHASE_TIMEOUT_MS, 'HLT_ECONOMIC_GATE_STARTED',
    );
    if (gatePid(startedPath, 'HLT_ECONOMIC_GATE_STARTED_PID_INVALID') !== workloadPid) {
      throw new Error('HLT_ECONOMIC_GATE_WORKLOAD_RESTARTED');
    }
    return await new Promise<number>((resolveExit, reject) => {
      if (child.exitCode !== null) return resolveExit(child.exitCode);
      const timeout = setTimeout(() => reject(new Error('HLT_ECONOMIC_GATE_RUN_TIMEOUT')), RUN_PHASE_TIMEOUT_MS);
      child.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timeout);
        resolveExit(code ?? 1);
      });
    });
  } catch (error) {
    if (!existsSync(abortPath) && !existsSync(startPath)) writeAtomic(abortPath, 'abort\n');
    // The child owns the entire local production process tree. Give its
    // existing finally block time to stop xlnrs; terminate only this owned
    // parent if it cannot observe the abort promptly.
    if (!(await waitForOwnedChildExit(child, 1_000))) {
      child.kill('SIGTERM');
      await waitForOwnedChildExit(child, 1_000);
    }
    throw error;
  }
};

/**
 * Prove the exact offline mixed TS↔production-Rust path before starting H1,
 * then keep one live production child across prepare and the economic window.
 * The proof is intentionally rerun in this invocation: no certificate or
 * persisted "passed" flag can become a second source of truth.
 */
export const runParityGatedHltChild = async (options: Readonly<{
  gateDir: string;
  parityCommand: string;
  parityArgs: readonly string[];
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}>): Promise<number> => {
  const reports = mkdtempSync(join(tmpdir(), 'xln-economic-parity-ts-'));
  try {
    for (const stageArgs of [
      [...options.parityArgs, '--ts-only', '--ts-report-dir', reports],
      [...options.parityArgs, '--resume-ts-report-dir', reports],
    ]) {
      const parity = spawnSync(options.parityCommand, stageArgs, {
        cwd: process.cwd(),
        // Offline parity owns no live process and must never recursively enter
        // ready/start orchestration inherited from its future HLT child.
        env: offlineParityEnv(options.env),
        stdio: 'inherit',
        timeout: AUTHORITY_EVIDENCE_GATE_BUDGET_MS,
      });
      if (parity.error) throw parity.error;
      if (parity.status !== 0) {
        throw new Error(
          `HLT_OFFLINE_MIXED_PARITY_FAILED:${String(parity.status)}:${String(parity.signal)}`,
        );
      }
    }
  } finally {
    rmSync(reports, { recursive: true, force: true });
  }
  return runGatedHltChild(options);
};
