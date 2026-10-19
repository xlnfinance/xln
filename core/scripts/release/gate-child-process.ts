import type { ChildProcess } from 'node:child_process';
import { stopProcessGroup } from '../e2e/runners/process-group';

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
