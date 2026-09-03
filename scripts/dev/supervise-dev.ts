#!/usr/bin/env bun

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';

export const DEV_ROLES = [
  'anvil',
  'anvil2',
  'mesh',
  'watchtower',
  'runtime',
  'vite',
  'vite-http',
  'ui',
  'ready',
] as const;

const DEV_BACKEND_ROLES = ['mesh', 'watchtower', 'runtime'] as const;
const DEV_FRONTEND_ROLES = ['vite', 'vite-http', 'ui', 'ready'] as const;
const DEV_APPLICATION_ROLES = [...DEV_BACKEND_ROLES, ...DEV_FRONTEND_ROLES] as const;
const DEV_CHAIN_BARRIER_ROLE = 'rpc-ready' as const;
const DEV_BACKEND_BARRIER_ROLE = 'backend-ready' as const;

type DevRole = typeof DEV_ROLES[number];
type DevChildRole = DevRole | typeof DEV_CHAIN_BARRIER_ROLE | typeof DEV_BACKEND_BARRIER_ROLE;
type DevRoleProcess = {
  readonly role: DevChildRole;
  readonly child: ChildProcess;
  readonly processGroupId: number;
  signalable: boolean;
};

export type DevSupervisorOptions = Readonly<{
  childScript: string;
  cwd: string;
  logDir: string;
  shutdownTimeoutMs: number;
}>;

const parsePositiveInteger = (name: string, value: string | undefined): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name}_INVALID:${String(value)}`);
  }
  return parsed;
};

export const readDevSupervisorOptions = (): DevSupervisorOptions => {
  const cwd = process.cwd();
  return {
    cwd,
    childScript: join(cwd, 'scripts/dev/run-dev-child.sh'),
    logDir: process.env['DEV_LOG_DIR'] || join(cwd, '.logs/dev'),
    shutdownTimeoutMs: parsePositiveInteger(
      'DEV_SHUTDOWN_TIMEOUT',
      process.env['DEV_SHUTDOWN_TIMEOUT_MS'],
    ),
  };
};

const waitForExit = (child: ChildProcess): Promise<void> => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.once('exit', () => resolve());
});

const waitForTimeout = (timeoutMs: number): Promise<void> => new Promise(resolve => {
  setTimeout(resolve, timeoutMs);
});

const isProcessGroupAlive = (processGroupId: number): boolean => {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
};

const signalProcessGroup = (processGroupId: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // ESRCH means the complete role process group already exited.
  }
};

export const shouldEchoDevLine = (role: DevChildRole, line: string, stderr: boolean): boolean => {
  if (stderr || role === 'ready' || role === DEV_CHAIN_BARRIER_ROLE || role === DEV_BACKEND_BARRIER_ROLE) return true;
  return /^(DEV_|CONTROL_READY|RPC2_JURISDICTION_READY|RUNTIME_IMPORT_READY|VITE_STARTING|UI_STARTING|Bundled|\s+runtime\.js)/.test(line)
    || line.includes('baseline ready')
    || line.includes('service.listen')
    || /\b(?:WARN|ERROR|FATAL)\b/.test(line);
};

export const isExpectedDevTerminationNotice = (line: string): boolean =>
  /^.+:\s+line \d+:\s+\d+\s+Terminated:\s+15(?:\s|$)/.test(line);

export async function superviseDev(options: DevSupervisorOptions): Promise<number> {
  await mkdir(options.logDir, { recursive: true });
  const logPath = join(options.logDir, 'dev.log');
  const log = createWriteStream(logPath, { flags: 'w', mode: 0o600 });
  const roleProcesses: DevRoleProcess[] = [];
  const startedAt = Date.now();
  let stopping = false;
  let settle: ((exitCode: number) => void) | null = null;
  const terminal = new Promise<number>(resolve => { settle = resolve; });

  const writeLine = (role: DevChildRole, line: string, stderr: boolean): void => {
    const rendered = `[${role.toUpperCase().replace('-', '_')}] ${line}`;
    log.write(`${rendered}\n`);
    const expectedTermination = stopping && stderr && isExpectedDevTerminationNotice(line);
    if (!expectedTermination && shouldEchoDevLine(role, line, stderr)) {
      (stderr ? process.stderr : process.stdout).write(`${rendered}\n`);
    }
  };

  const requestStop = (exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    settle?.(exitCode);
  };

  const spawnRole = (role: DevChildRole): DevRoleProcess => {
    const chainsReady = DEV_APPLICATION_ROLES.includes(role as typeof DEV_APPLICATION_ROLES[number])
      || role === DEV_BACKEND_BARRIER_ROLE;
    const child = spawn('bash', [options.childScript, role], {
      cwd: options.cwd,
      env: chainsReady ? { ...process.env, XLN_DEV_CHAINS_READY: '1' } : process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!child.pid) throw new Error(`DEV_ROLE_PID_MISSING:${role}`);
    const roleProcess: DevRoleProcess = { role, child, processGroupId: child.pid, signalable: true };
    roleProcesses.push(roleProcess);
    createInterface({ input: child.stdout! }).on('line', line => writeLine(role, line, false));
    createInterface({ input: child.stderr! }).on('line', line => writeLine(role, line, true));
    child.once('error', error => {
      writeLine(role, `DEV_ROLE_SPAWN_FAILED:${error.message}`, true);
      requestStop(1);
    });
    child.once('exit', (code, signal) => {
      if (stopping) {
        roleProcess.signalable = false;
        return;
      }
      if ((role === 'ready' || role === DEV_CHAIN_BARRIER_ROLE || role === DEV_BACKEND_BARRIER_ROLE) && code === 0) {
        // Finite readiness roles have no live descendant after their wrapper
        // exits. Retire the PGID immediately so PID reuse can never make a
        // later shutdown signal an unrelated process group.
        roleProcess.signalable = false;
        return;
      }
      signalProcessGroup(roleProcess.processGroupId, 'SIGKILL');
      roleProcess.signalable = false;
      writeLine(
        role,
        `DEV_ROLE_EXIT code=${code === null ? 'null' : code} signal=${signal ?? 'none'}`,
        true,
      );
      requestStop(code && code > 0 ? code : 1);
    });
    return roleProcess;
  };

  const onSignal = (exitCode: number): void => {
    if (stopping) {
      for (const roleProcess of roleProcesses) {
        if (roleProcess.signalable) signalProcessGroup(roleProcess.processGroupId, 'SIGKILL');
      }
      return;
    }
    requestStop(exitCode);
  };
  const onInterrupt = (): void => onSignal(130);
  const onTerminate = (): void => onSignal(143);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  spawnRole('anvil');
  spawnRole('anvil2');
  const barrier = spawnRole(DEV_CHAIN_BARRIER_ROLE);
  const firstOutcome = await Promise.race([
    waitForExit(barrier.child).then(() => 'barrier' as const),
    terminal.then(() => 'terminal' as const),
  ]);
  if (firstOutcome === 'barrier' && !stopping) {
    for (const role of DEV_BACKEND_ROLES) spawnRole(role);
    const backendBarrier = spawnRole(DEV_BACKEND_BARRIER_ROLE);
    const backendOutcome = await Promise.race([
      waitForExit(backendBarrier.child).then(() => 'backend' as const),
      terminal.then(() => 'terminal' as const),
    ]);
    if (backendOutcome === 'backend' && !stopping) {
      for (const role of DEV_FRONTEND_ROLES) spawnRole(role);
    }
  }

  const exitCode = await terminal;
  for (const roleProcess of roleProcesses) {
    if (roleProcess.signalable) signalProcessGroup(roleProcess.processGroupId, 'SIGTERM');
  }
  const deadline = Date.now() + options.shutdownTimeoutMs;
  while (
    roleProcesses.some(roleProcess => roleProcess.signalable && isProcessGroupAlive(roleProcess.processGroupId)) &&
    Date.now() < deadline
  ) {
    await waitForTimeout(25);
  }
  const survivors = roleProcesses.filter(
    roleProcess => roleProcess.signalable && isProcessGroupAlive(roleProcess.processGroupId),
  );
  if (survivors.length > 0) {
    process.stderr.write(`DEV_SUPERVISOR_FORCE_STOP count=${survivors.length}\n`);
    for (const roleProcess of survivors) signalProcessGroup(roleProcess.processGroupId, 'SIGKILL');
  }
  await Promise.all(roleProcesses.map(roleProcess => waitForExit(roleProcess.child)));

  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  const elapsedMs = Date.now() - startedAt;
  const finalLine = `DEV_STOPPED exitCode=${exitCode} elapsedMs=${elapsedMs}`;
  log.write(`${finalLine}\n`);
  process.stdout.write(`${finalLine}\n`);
  await new Promise<void>((resolve, reject) => {
    log.once('error', reject);
    log.end(resolve);
  });
  return exitCode;
}

if (import.meta.main) {
  superviseDev(readDevSupervisorOptions()).then(
    exitCode => { process.exitCode = exitCode; },
    error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
