import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { stopProcessGroup } from '../e2e/runners/process-group';
import { XLN_RELEASE_PATHS } from '../../../tools/release-snapshot/scope';

/**
 * Gate commands run through a shell and may spawn browsers, RPC nodes and test
 * workers. Killing only the shell leaks those descendants into the next gate.
 * POSIX detached mode gives each step its own process group; timeout cleanup
 * then terminates the whole group before the gate reports completion.
 */
export const GATE_CHILD_PROCESS_DETACHED = process.platform !== 'win32';

const waitForChildExit = async (
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  return true;
};

/** Terminate and verify the entire gate process tree, even if its shell exits first. */
export const terminateGateProcessGroup = async (
  child: ChildProcess,
  graceMs = 5_000,
): Promise<void> => {
  if (child.pid && GATE_CHILD_PROCESS_DETACHED) {
    return stopProcessGroup({
      pid: child.pid,
      termTimeoutMs: graceMs,
      killTimeoutMs: graceMs,
      timeoutError: `GATE_PROCESS_GROUP_TERMINATION_FAILED:${child.pid}`,
    });
  }
  child.kill('SIGTERM');
  if (await waitForChildExit(child, graceMs)) return;
  child.kill('SIGKILL');
  if (!await waitForChildExit(child, graceMs)) {
    throw new Error(`GATE_PROCESS_GROUP_TERMINATION_FAILED:${String(child.pid)}`);
  }
};

export type GateCommand = Readonly<{ name: string; command: string; timeoutMs: number }>;
export type GateStepResult<S extends GateCommand> = S & { status: 'pass' | 'fail'; code: number | null; durationMs: number };

/** One gate step in its own process group: prefixed live output, verified timeout kill. */
export const runGateStep = async <S extends GateCommand>(
  step: S, label: string, env: NodeJS.ProcessEnv,
): Promise<GateStepResult<S>> => {
  const startedAt = Date.now();
  const proc = spawn('sh', ['-lc', step.command], {
    cwd: process.cwd(), env, detached: GATE_CHILD_PROCESS_DETACHED, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', chunk => process.stdout.write(`[${label}] ${chunk.toString()}`));
  proc.stderr.on('data', chunk => process.stderr.write(`[${label}] ${chunk.toString()}`));
  let termination: Promise<void> | null = null;
  const timer = setTimeout(() => { termination = terminateGateProcessGroup(proc); }, step.timeoutMs);
  timer.unref();
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', resolve);
  });
  clearTimeout(timer);
  if (termination) await termination;
  const resultCode = termination !== null ? 124 : code;
  return { ...step, status: resultCode === 0 ? 'pass' : 'fail', code: resultCode, durationMs: Date.now() - startedAt };
};

/** Fail-fast sequence shared by every release gate: the first red stops the run. */
export const runGateSteps = async <S extends GateCommand>(steps: readonly S[], options: Readonly<{
  label: (step: S) => string;
  env: () => NodeJS.ProcessEnv;
  beforeStep?: (step: S) => void;
  afterStep?: (results: readonly GateStepResult<S>[]) => void;
}>): Promise<{ results: GateStepResult<S>[]; firstRed: GateStepResult<S> | null }> => {
  const results: GateStepResult<S>[] = [];
  for (const step of steps) {
    options.beforeStep?.(step);
    const result = await runGateStep(step, options.label(step), options.env());
    results.push(result);
    options.afterStep?.(results);
    if (result.code !== 0) return { results, firstRed: result };
  }
  return { results, firstRed: null };
};

const git = (args: string[]): string => {
  const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`GATE_GIT_UNAVAILABLE:${args.join(' ')}:${String(result.stderr).trim()}`);
  return String(result.stdout).trimEnd();
};

/** The committed SHA under test and any uncommitted release-path source. */
export const readGateSource = (): { head: string; dirty: string } => ({
  head: git(['rev-parse', 'HEAD']),
  dirty: git(['status', '--short', '--untracked-files=all', '--', ...XLN_RELEASE_PATHS]),
});
