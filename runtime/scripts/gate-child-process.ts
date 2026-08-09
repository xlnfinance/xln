import type { ChildProcess } from 'node:child_process';

/**
 * Gate commands run through a shell and may spawn browsers, RPC nodes and test
 * workers. Killing only the shell leaks those descendants into the next gate.
 * POSIX detached mode gives each step its own process group; timeout cleanup
 * then terminates the whole group before the gate reports completion.
 */
export const GATE_CHILD_PROCESS_DETACHED = process.platform !== 'win32';

export const signalGateProcessGroup = (
  child: ChildProcess,
  signal: NodeJS.Signals,
): void => {
  if (child.pid && GATE_CHILD_PROCESS_DETACHED) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
  }
  child.kill(signal);
};

const gateProcessGroupAlive = (child: ChildProcess): boolean => {
  if (!child.pid || !GATE_CHILD_PROCESS_DETACHED) return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

const waitForGateProcessGroupExit = async (
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (gateProcessGroupAlive(child)) {
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
  signalGateProcessGroup(child, 'SIGTERM');
  if (await waitForGateProcessGroupExit(child, graceMs)) return;
  signalGateProcessGroup(child, 'SIGKILL');
  if (!await waitForGateProcessGroupExit(child, graceMs)) {
    throw new Error(`GATE_PROCESS_GROUP_TERMINATION_FAILED:${String(child.pid)}`);
  }
};
