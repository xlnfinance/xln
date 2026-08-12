#!/usr/bin/env bun
/**
 * Canonical local-development entrypoint.
 *
 * One kernel-held loopback listener owns the canonical dev stack. Shell
 * stages need its unforgeable capability, and every stage runs in a detached
 * process group so shutdown cannot leave ports or grandchildren behind.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

import { stopProcessGroup } from '../../runtime/scripts/e2e/runners/process-group';

export const DEV_SINGLETON_PORT = 17_999;
export const DEV_LAUNCHER_SHUTDOWN_TIMEOUT_MS = 90_000;
export const DEV_LAUNCHER_KILL_TIMEOUT_MS = 5_000;
export const DEV_CAPABILITY_HEADER = 'x-xln-dev-capability';

type DevMode = 'default' | 'debug' | 'trace' | 'verbose';
type DevCommand = readonly [string, ...string[]];

export type DevSingletonLease = Readonly<{
  port: number;
  capability: string;
  release: () => void;
}>;

const capabilityMatches = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

export function acquireDevSingleton(port = DEV_SINGLETON_PORT): DevSingletonLease {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`DEV_SINGLETON_PORT_INVALID:${String(port)}`);
  }
  const capability = randomBytes(32).toString('hex');
  let server: Bun.Server<unknown>;
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: request => {
        const url = new URL(request.url);
        const allowed = request.method === 'POST' &&
          url.pathname === '/capability' &&
          capabilityMatches(request.headers.get(DEV_CAPABILITY_HEADER) ?? '', capability);
        return new Response(null, { status: allowed ? 204 : 403 });
      },
    });
  } catch (cause) {
    throw new Error(`DEV_ALREADY_RUNNING:127.0.0.1:${port}`, { cause });
  }
  let released = false;
  return {
    port: server.port,
    capability,
    release: () => {
      if (released) return;
      released = true;
      server.stop(true);
    },
  };
}

const parseInvocation = (): { mode: DevMode; commands: readonly DevCommand[] } => {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    return {
      mode: 'default',
      commands: [
        ['bash', 'scripts/dev/prepare-start.sh'],
        ['bash', 'scripts/dev/run-dev.sh'],
      ],
    };
  }
  if (args.length === 1 && args[0] === '--clean') {
    return { mode: 'default', commands: [['bash', 'scripts/dev/clean-slate.sh']] };
  }
  if (args.length === 1 && args[0]?.startsWith('--mode=')) {
    const mode = args[0].slice('--mode='.length);
    if (mode === 'default' || mode === 'debug' || mode === 'trace' || mode === 'verbose') {
      return {
        mode,
        commands: [
          ['bash', 'scripts/dev/prepare-start.sh'],
          ['bash', 'scripts/dev/run-dev.sh'],
        ],
      };
    }
  }
  throw new Error(`DEV_MODE_INVALID:${args.join(' ')}`);
};

const environmentForMode = (mode: DevMode, lease: DevSingletonLease): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XLN_DEV_LAUNCHER_PORT: String(lease.port),
    XLN_DEV_LAUNCHER_TOKEN: lease.capability,
    RUNTIME_VERBOSE_LOGS: mode === 'verbose' ? '1' : '0',
    DEV_VERBOSE: mode === 'verbose' ? '1' : '0',
  };
  if (mode === 'debug') {
    env['XLN_LOG_LEVEL'] = 'debug';
    env['XLN_LOG_SCOPES'] = 'entity,account,account.handler,orderbook,p2p';
  } else if (mode === 'trace') {
    env['XLN_LOG_LEVEL'] = 'trace';
  }
  return env;
};

export type DevRunOptions = Readonly<{
  cwd?: string;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
}>;

const spawnDevProcessGroup = (
  command: DevCommand,
  env: NodeJS.ProcessEnv,
  cwd: string,
): { child: ChildProcess; pid: number; exited: Promise<number> } => {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env,
    detached: true,
    stdio: 'inherit',
  });
  const pid = child.pid;
  if (!pid) throw new Error(`DEV_CHILD_SPAWN_FAILED:${command.join(' ')}`);
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
  return { child, pid, exited };
};

export const runDevCommands = async (
  commands: readonly DevCommand[],
  env: NodeJS.ProcessEnv,
  options: DevRunOptions = {},
): Promise<number> => {
  const cwd = options.cwd ?? import.meta.dir + '/../..';
  const termTimeoutMs = options.termTimeoutMs ?? DEV_LAUNCHER_SHUTDOWN_TIMEOUT_MS;
  const killTimeoutMs = options.killTimeoutMs ?? DEV_LAUNCHER_KILL_TIMEOUT_MS;
  let active: ReturnType<typeof spawnDevProcessGroup> | null = null;
  let stopping: Promise<void> | null = null;
  let signalExitCode: number | null = null;

  const stopActive = (): Promise<void> => {
    if (!active) return Promise.resolve();
    if (stopping) return stopping;
    const pid = active.pid;
    stopping = stopProcessGroup({
      pid,
      termTimeoutMs,
      killTimeoutMs,
      timeoutError: `DEV_PROCESS_GROUP_STOP_TIMEOUT:pid=${pid}`,
      onEscalate: () => console.error(`[dev] force-stopping process group pid=${pid}`),
    });
    return stopping;
  };
  const requestStop = (exitCode: number): void => {
    if (signalExitCode !== null) return;
    signalExitCode = exitCode;
    void stopActive().catch(error => {
      console.error(error instanceof Error ? error.message : String(error));
    });
  };
  const interrupt = (): void => requestStop(130);
  const terminate = (): void => requestStop(143);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);

  try {
    for (const command of commands) {
      if (signalExitCode !== null) return signalExitCode;
      active = spawnDevProcessGroup(command, env, cwd);
      stopping = null;
      const exitCode = await active.exited;
      // Even a naturally exited shell may have left detached descendants in
      // its process group. Reap that entire group before advancing/releasing.
      await stopActive();
      active = null;
      stopping = null;
      if (signalExitCode !== null) return signalExitCode;
      if (exitCode !== 0) return exitCode;
    }
    return 0;
  } finally {
    await stopActive();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
};

const runDev = async (): Promise<number> => {
  if (process.env['XLN_PORT_BASE']) throw new Error('DEV_PORT_OVERRIDE_FORBIDDEN:XLN_PORT_BASE');
  const { mode, commands } = parseInvocation();
  const lease = acquireDevSingleton();
  try {
    return await runDevCommands(commands, environmentForMode(mode, lease));
  } finally {
    lease.release();
  }
};

if (import.meta.main) {
  runDev().then(
    exitCode => { process.exitCode = exitCode; },
    error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
