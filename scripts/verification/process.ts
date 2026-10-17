import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';
import { signalProcessGroup, stopProcessGroup } from '../../core/scripts/e2e/runners/process-group';

export type CommandResult = Readonly<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  interrupted: NodeJS.Signals | null;
  error: string | null;
  cleanup: Readonly<{ pids: number[]; groups: number[] }> | null;
}>;

type CheckChild = ReturnType<typeof spawn>;

const ownedProcesses = (rootPid: number): { pids: number[]; groups: number[] } => {
  const listing = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,pgid='], {
    timeout: 1_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (listing.exitCode !== 0) throw new Error(`VERIFY_PROCESS_ANCESTRY_FAILED:${listing.stderr.toString().trim()}`);
  const rows = listing.stdout
    .toString()
    .trim()
    .split('\n')
    .map(line => {
      const values = line.trim().split(/\s+/u).map(Number);
      if (values.length !== 3 || values.some(value => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error('VERIFY_PROCESS_ANCESTRY_ROW_INVALID');
      }
      return { pid: values[0]!, parent: values[1]!, group: values[2]! };
    });
  const pids = new Set([rootPid]);
  for (const parent of pids) for (const row of rows) if (row.parent === parent) pids.add(row.pid);
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const groups = new Set([
    rootPid,
    ...[...pids].flatMap(pid => {
      const row = byPid.get(pid);
      return row ? [row.group] : [];
    }),
  ]);
  if ([...groups].some(group => !pids.has(group))) throw new Error('VERIFY_PROCESS_GROUP_OWNER_UNPROVEN');
  return { pids: [...pids], groups: [...groups] };
};

const stopOwnedGroups = async (groups: readonly number[]): Promise<void> => {
  const errors: string[] = [];
  const termDeadline = performance.now() + 1_000;
  // Parent wrappers must receive TERM before their children. They forward it,
  // reap their own detached groups and release leases; simultaneous child TERM
  // races that cleanup on Darwin while exited group members await reaping.
  for (const pid of groups) {
    try {
      await stopProcessGroup({
        pid,
        signal: 'SIGTERM',
        termTimeoutMs: Math.max(0, Math.min(250, termDeadline - performance.now())),
        killTimeoutMs: 1_000,
        timeoutError: `VERIFY_DESCENDANT_GROUP_STOP_FAILED:pid=${pid}`,
      });
    } catch (error) {
      errors.push(String(error));
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
};

const controlChild = (child: CheckChild, timeoutMs: number) => {
  const state: {
    timedOut: boolean;
    interrupted: NodeJS.Signals | null;
    error: string | null;
    cleanup: { pids: number[]; groups: number[] } | null;
  } = {
    timedOut: false,
    interrupted: null,
    error: null,
    cleanup: null,
  };
  let stopping: Promise<void> | null = null;
  const stop = (): void => {
    if (!child.pid || stopping) return;
    try {
      state.cleanup = ownedProcesses(child.pid);
      stopping = stopOwnedGroups(state.cleanup.groups).catch(failure => {
        state.error = String(failure);
      });
    } catch (failure) {
      state.error = String(failure);
      try {
        signalProcessGroup(child.pid, 'SIGKILL');
      } catch (killFailure) {
        state.error += `\n${String(killFailure)}`;
      }
    }
  };
  const timer = setTimeout(() => {
    state.timedOut = true;
    stop();
  }, timeoutMs);
  const processEvents: NodeJS.EventEmitter = process;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const handler = (): void => {
      state.interrupted = signal;
      stop();
    };
    handlers.set(signal, handler);
    processEvents.on(signal, handler);
  }
  child.on('error', failure => {
    state.error = failure.message;
  });
  const dispose = (): void => {
    clearTimeout(timer);
    for (const [signal, handler] of handlers) processEvents.off(signal, handler);
  };
  return {
    state,
    dispose,
    finish: async (): Promise<void> => {
      await stopping;
    },
  };
};

const captureOutput = (child: Pick<ChildProcessWithoutNullStreams, 'stdout' | 'stderr'>, logFd: number): void => {
  child.stdout.on('data', (data: Buffer) => {
    writeSync(logFd, data);
    process.stdout.write(data);
  });
  child.stderr.on('data', (data: Buffer) => {
    writeSync(logFd, data);
    process.stderr.write(data);
  });
};

export const runBoundedCommand = async (
  command: readonly [string, ...string[]],
  cwd: string,
  logFd: number,
  timeoutMs: number,
): Promise<CommandResult> => {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` },
  });
  const { state, dispose, finish } = controlChild(child, timeoutMs);
  captureOutput(child, logFd);
  try {
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      const deadline = setTimeout(() => {
        state.error = `${state.error ?? ''}\nVERIFY_CHILD_STREAMS_OPEN_AFTER_CLEANUP:pid=${child.pid}`.trim();
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ code: null, signal: null });
      }, timeoutMs + 2_500);
      child.once('close', (code, signal) => {
        clearTimeout(deadline);
        resolve({ code, signal });
      });
    });
    await finish();
    if (child.pid)
      await stopProcessGroup({
        pid: child.pid,
        signal: 'SIGKILL',
        termTimeoutMs: 1_000,
        killTimeoutMs: 1_000,
        timeoutError: `VERIFY_CHILD_GROUP_STOP_FAILED:pid=${child.pid}`,
      });
    return {
      exitCode: state.timedOut ? 124 : state.interrupted ? 128 : (closed.code ?? 1),
      signal: closed.signal,
      ...state,
    };
  } finally {
    dispose();
  }
};
