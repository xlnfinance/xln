import { spawn } from 'node:child_process';
import { signalProcessGroup, stopProcessGroup } from '../../core/scripts/e2e/runners/process-group';
import { buildStandLockChildEnv, registerStandGroup, releaseStandLock, type StandLockGrant } from '../stand-lock';

/** Only the new child process group is ours. Never signal by executable name.
 * Release follows verified group exit, including leftovers after a successful
 * parent exit. A cleanup failure retains the slot rather than admitting work. */
export const runStandChild = async (
  grant: StandLockGrant,
  command: string[],
  timeoutMs: number,
  lease: 'owned' | 'inherited' = 'owned',
): Promise<number> => {
  if (!command[0] || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    if (lease === 'owned') releaseStandLock(grant);
    throw new Error('STAND_LOCK_RUN_ARGUMENT_INVALID');
  }
  const child = spawn(command[0], command.slice(1), {
    detached: true,
    stdio: 'inherit',
    env: buildStandLockChildEnv(process.env, grant.token),
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  // Attach immediately: registration can fail before the result is awaited.
  void exited.catch(() => undefined);
  let interrupted = 0;
  const processEvents: NodeJS.EventEmitter = process;
  const handlers = new Map<'SIGINT' | 'SIGTERM' | 'SIGHUP', () => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!child.pid) return await exited;
    const pid = child.pid;
    // A nested command owns its child group, never the parent's metadata or
    // slot. Retain the outer group so its lifetime still fences other stands.
    if (lease === 'owned') registerStandGroup(grant, pid);
    const stop = (code: number): void => {
      interrupted ||= code;
      signalProcessGroup(pid, 'SIGTERM');
      if (!escalation) escalation = setTimeout(() => signalProcessGroup(pid, 'SIGKILL'), 2_000);
    };
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const) {
      const handler = (): void => stop(code);
      handlers.set(signal, handler);
      processEvents.on(signal, handler);
    }
    timer = setTimeout(() => stop(124), timeoutMs);
    const code = await exited;
    return interrupted || code;
  } finally {
    if (timer) clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    try {
      if (child.pid)
        await stopProcessGroup({
          pid: child.pid,
          termTimeoutMs: 2_000,
          killTimeoutMs: 2_000,
          timeoutError: 'STAND_LOCK_CHILD_CLEANUP_FAILED',
        });
      if (lease === 'owned') releaseStandLock(grant);
    } finally {
      for (const [signal, handler] of handlers) processEvents.off(signal, handler);
    }
  }
};
