import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStructuredLogger } from '../infra/logger';
import { safeStringify } from '../protocol/serialization';
import type { ManagedRuntimeLease, ManagedRuntimeSpec } from './orchestrator-types';

export type ManagedProcessTableEntry = { pid: number; command: string };

export type ManagedProcessOps = {
  kill(pid: number, signal: NodeJS.Signals | 0): true;
  sleep(ms: number): Promise<void>;
};

type ManagedRuntimeLeaseManagerConfig = {
  controlPlaneDir: string;
  ownerId: string;
};

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const managedLeaseLog = createStructuredLogger('orchestrator.managed_leases');

const defaultProcessOps: ManagedProcessOps = {
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: delay,
};

const isPidAlive = (pid: number, ops: ManagedProcessOps = defaultProcessOps): boolean => {
  try {
    ops.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw new Error(`MANAGED_RUNTIME_PID_PROBE_FAILED:pid=${pid}:error=${formatError(error)}`, {
      cause: error,
    });
  }
};

const commandMatchesManagedRuntime = (command: string, spec: ManagedRuntimeSpec): boolean => {
  if (!command.includes(spec.script)) return false;
  if (!command.includes(`--name ${spec.name}`) && !command.includes(`--name=${spec.name}`)) return false;
  const hasApiPort =
    command.includes(`--api-port ${spec.apiPort}`) ||
    command.includes(`--api-port=${spec.apiPort}`);
  const hasDbPath =
    command.includes(`--db-path ${spec.dbPath}`) ||
    command.includes(`--db-path=${spec.dbPath}`);
  return hasApiPort && hasDbPath;
};

export const killManagedProcessIds = async (
  pids: number[],
  label: string,
  ops: ManagedProcessOps = defaultProcessOps,
): Promise<void> => {
  if (pids.length === 0) return;
  managedLeaseLog.warn('stale_processes.kill', { label, pids });
  for (const pid of pids) {
    try {
      ops.kill(pid, 'SIGTERM');
    } catch (error) {
      managedLeaseLog.warn('stale_process.sigterm_failed', { label, pid, error: formatError(error) });
    }
  }
  await ops.sleep(1_000);
  for (const pid of pids) {
    if (!isPidAlive(pid, ops)) continue;
    try {
      ops.kill(pid, 'SIGKILL');
    } catch (error) {
      managedLeaseLog.warn('stale_process.sigkill_failed', { label, pid, error: formatError(error) });
    }
  }
  await ops.sleep(200);
  const survivors = pids.filter(pid => isPidAlive(pid, ops));
  if (survivors.length > 0) {
    managedLeaseLog.error('stale_processes.survived_sigkill', { label, pids: survivors });
    throw new Error(`MANAGED_RUNTIME_PROCESS_TERMINATION_FAILED:${label}:pids=${survivors.join(',')}`);
  }
};

export const readManagedProcessTable = async (
  spawnProcess: typeof spawn = spawn,
): Promise<ManagedProcessTableEntry[]> => {
  return await new Promise<ManagedProcessTableEntry[]>((resolve, reject) => {
    const child = spawnProcess('ps', ['-axo', 'pid=,command='], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!child.stdout || !child.stderr) {
      reject(new Error('MANAGED_PROCESS_TABLE_PIPE_UNAVAILABLE'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', error => {
      if (settled) return;
      settled = true;
      reject(new Error(`MANAGED_PROCESS_TABLE_SPAWN_FAILED:${formatError(error)}`, { cause: error }));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(
          `MANAGED_PROCESS_TABLE_EXIT_FAILED:code=${String(code)}:signal=${String(signal || '')}:` +
          `stderr=${stderr.trim() || 'empty'}`,
        ));
        return;
      }
      const rows = stdout
        .split(/\r?\n/)
        .map((line): ManagedProcessTableEntry | null => {
          const match = line.match(/^\s*(\d+)\s+(.+)$/);
          if (!match) return null;
          const pid = Number.parseInt(match[1]!, 10);
          if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
          return { pid, command: match[2]!.trim() };
        })
        .filter((row): row is ManagedProcessTableEntry => row !== null);
      resolve(rows);
    });
  });
};

export const createManagedRuntimeLeaseManager = (config: ManagedRuntimeLeaseManagerConfig) => {
  const leasePathFor = (spec: ManagedRuntimeSpec): string =>
    join(config.controlPlaneDir, `${spec.role}-${spec.name.toLowerCase()}.lease.json`);

  const readLease = (spec: ManagedRuntimeSpec): ManagedRuntimeLease | null => {
    const path = leasePathFor(spec);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ManagedRuntimeLease>;
      if (
        parsed.role === spec.role &&
        parsed.name === spec.name &&
        parsed.script === spec.script &&
        Number(parsed.apiPort) === spec.apiPort &&
        String(parsed.dbPath || '') === spec.dbPath &&
        typeof parsed.ownerId === 'string' &&
        Number.isFinite(parsed.pid)
      ) {
        return {
          role: spec.role,
          name: spec.name,
          script: spec.script,
          apiPort: spec.apiPort,
          dbPath: spec.dbPath,
          ownerId: parsed.ownerId,
          orchestratorPid: Number(parsed.orchestratorPid || 0),
          pid: Number(parsed.pid),
          cwd: String(parsed.cwd || ''),
          startedAt: Number(parsed.startedAt || 0),
          updatedAt: Number(parsed.updatedAt || 0),
        };
      }
    } catch (error) {
      managedLeaseLog.warn('lease.unreadable_ignored', { path, error: formatError(error) });
    }
    return null;
  };

  const writeLease = (spec: ManagedRuntimeSpec, pid: number, startedAt: number): void => {
    mkdirSync(config.controlPlaneDir, { recursive: true });
    const lease: ManagedRuntimeLease = {
      ...spec,
      ownerId: config.ownerId,
      orchestratorPid: process.pid,
      pid,
      cwd: process.cwd(),
      startedAt,
      updatedAt: Date.now(),
    };
    const path = leasePathFor(spec);
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, `${safeStringify(lease)}\n`);
    renameSync(tmpPath, path);
  };

  const removeLease = (spec: ManagedRuntimeSpec, pid?: number | null): void => {
    const lease = readLease(spec);
    if (!lease) return;
    if (lease.ownerId !== config.ownerId) return;
    if (pid !== undefined && pid !== null && lease.pid !== pid) return;
    rmSync(leasePathFor(spec), { force: true });
  };

  const reapStale = async (
    spec: ManagedRuntimeSpec,
    currentPid: number,
    processTable?: ManagedProcessTableEntry[],
  ): Promise<void> => {
    const table = processTable ?? await readManagedProcessTable();
    const candidates = new Set<number>();
    const lease = readLease(spec);
    if (lease) {
      if (!isPidAlive(lease.pid)) {
        rmSync(leasePathFor(spec), { force: true });
      } else if (lease.ownerId !== config.ownerId && lease.pid !== currentPid) {
        candidates.add(lease.pid);
      }
    }

    const commandByPid = new Map<number, string>();
    for (const row of table) {
      commandByPid.set(row.pid, row.command);
      if (row.pid === currentPid) continue;
      if (commandMatchesManagedRuntime(row.command, spec)) candidates.add(row.pid);
    }

    const verified: number[] = [];
    for (const pid of candidates) {
      if (pid === process.pid || pid === currentPid || !isPidAlive(pid)) continue;
      const command = commandByPid.get(pid) || '';
      if (commandMatchesManagedRuntime(command, spec)) {
        verified.push(pid);
      }
    }

    await killManagedProcessIds(verified, `${spec.name} ${spec.role} process(es)`);
  };

  return {
    leasePathFor,
    readLease,
    writeLease,
    removeLease,
    reapStale,
  };
};
