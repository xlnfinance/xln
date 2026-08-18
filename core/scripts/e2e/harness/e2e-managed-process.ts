import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export type ManagedChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export type ManagedProcessStopStep = Readonly<{
  label: string;
  proc: ManagedChildProcess | null;
  termTimeoutMs?: number;
}>;

const hasProcessExited = (proc: ManagedChildProcess): boolean => (
  proc.exitCode !== null || proc.signalCode !== null
);

const hasStreamClosed = (stream: Readable): boolean => (
  stream.readableEnded || stream.destroyed
);

const hasProcessAndOutputClosed = (proc: ManagedChildProcess): boolean => (
  hasProcessExited(proc)
  && hasStreamClosed(proc.stdout)
  && hasStreamClosed(proc.stderr)
);

export const waitForProcessClose = async (
  proc: ManagedChildProcess,
  timeoutMs: number,
): Promise<boolean> => {
  if (hasProcessAndOutputClosed(proc)) return true;
  return await new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('close', onClose);
      resolve(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(hasProcessAndOutputClosed(proc)), timeoutMs);
    proc.once('close', onClose);
    queueMicrotask(() => {
      if (hasProcessAndOutputClosed(proc)) finish(true);
    });
  });
};

const signalProcess = async (
  proc: ManagedChildProcess,
  signal: NodeJS.Signals,
): Promise<void> => {
  if (hasProcessExited(proc)) return;
  try {
    const signalSent = proc.kill(signal);
    if (signalSent) return;
  } catch (cause) {
    if (hasProcessExited(proc)) return;
    throw new Error(`MANAGED_CHILD_PROCESS_${signal}_FAILED:pid=${String(proc.pid ?? 'unknown')}`, { cause });
  }

  if (await waitForProcessClose(proc, 50)) return;
  throw new Error(`MANAGED_CHILD_PROCESS_${signal}_FAILED:pid=${String(proc.pid ?? 'unknown')}`);
};

export const stopProcess = async (
  proc: ManagedChildProcess | null,
  termTimeoutMs = 1_200,
): Promise<void> => {
  if (!proc || hasProcessAndOutputClosed(proc)) return;

  await signalProcess(proc, 'SIGTERM');
  if (await waitForProcessClose(proc, termTimeoutMs)) return;

  if (hasProcessExited(proc)) {
    throw new Error(`MANAGED_CHILD_PROCESS_OUTPUT_DRAIN_TIMEOUT:pid=${String(proc.pid ?? 'unknown')}`);
  }

  await signalProcess(proc, 'SIGKILL');
  if (await waitForProcessClose(proc, 1_200)) return;
  throw new Error(`MANAGED_CHILD_PROCESS_CLOSE_TIMEOUT:pid=${String(proc.pid ?? 'unknown')}`);
};

export const stopProcessDependencyChain = async (
  steps: readonly ManagedProcessStopStep[],
): Promise<void> => {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await stopProcess(step.proc, step.termTimeoutMs);
    } catch (cause) {
      failures.push(new Error(`MANAGED_CHILD_PROCESS_STOP_FAILED:${step.label}`, { cause }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'MANAGED_CHILD_PROCESS_DEPENDENCY_CHAIN_FAILED');
  }
};
