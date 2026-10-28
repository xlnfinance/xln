import { afterEach } from 'bun:test';
import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { signalProcessGroup, stopProcessGroup } from '../../scripts/e2e/runners/process-group';

const ownedPids = new Set<number>();

// Register ownership before callers can await readiness or fail an assertion.
// Detached children have their own group, so descendants are owned as well.
export const spawnTestProcess = (
  command: string, args: readonly string[], options: SpawnOptionsWithoutStdio = {},
) => {
  const child = spawn(command, args, { ...options, detached: true });
  if (child.pid) ownedPids.add(child.pid);
  return child;
};

export const cleanupTestProcesses = async (): Promise<void> => {
  const results = await Promise.allSettled([...ownedPids].map(async pid => {
    await stopProcessGroup({
      pid, termTimeoutMs: 1_200, killTimeoutMs: 1_200,
      timeoutError: `TEST_PROCESS_GROUP_CLEANUP_TIMEOUT:pid=${pid}`,
    });
    ownedPids.delete(pid);
  }));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'TEST_PROCESS_CLEANUP_FAILED');
};

const killOwnedGroups = (): void => {
  for (const pid of ownedPids) {
    try {
      signalProcessGroup(pid, 'SIGKILL');
    } catch (error) {
      process.stderr.write(`TEST_PROCESS_ABORT_CLEANUP_FAILED:pid=${pid}:${String(error)}\n`);
      process.exitCode = 1;
    }
  }
};

afterEach(cleanupTestProcesses);
process.once('exit', killOwnedGroups);
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.once(signal, () => {
    killOwnedGroups();
    process.exit(code);
  });
}
