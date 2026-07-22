import { setTimeout as delay } from 'node:timers/promises';

export type StopProcessGroupOptions = Readonly<{
  pid: number;
  signal?: NodeJS.Signals;
  termTimeoutMs: number;
  killTimeoutMs: number;
  timeoutError: string;
  onEscalate?: () => void;
}>;

export const processGroupIsAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
};

export const signalProcessGroup = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error(`PROCESS_GROUP_SIGNAL_FAILED:pid=${pid}:signal=${signal}`, { cause: error });
  }
};

export const waitForProcessGroupExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!processGroupIsAlive(pid)) return true;
    await delay(25);
  }
  return !processGroupIsAlive(pid);
};

export const stopProcessGroup = async (options: StopProcessGroupOptions): Promise<void> => {
  if (!signalProcessGroup(options.pid, options.signal ?? 'SIGTERM')) return;
  if (await waitForProcessGroupExit(options.pid, options.termTimeoutMs)) return;
  options.onEscalate?.();
  signalProcessGroup(options.pid, 'SIGKILL');
  if (await waitForProcessGroupExit(options.pid, options.killTimeoutMs)) return;
  throw new Error(options.timeoutError);
};
