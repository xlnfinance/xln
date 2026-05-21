import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { safeStringify } from '../serialization-utils';
import type { ManagedRuntimeLease, ManagedRuntimeSpec } from './orchestrator-types';

export type ManagedProcessTableEntry = { pid: number; command: string };

type ManagedRuntimeLeaseManagerConfig = {
  controlPlaneDir: string;
  ownerId: string;
};

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

const killProcessIds = async (pids: number[], label: string): Promise<void> => {
  if (pids.length === 0) return;
  console.warn(`[MESH] killing stale ${label}: ${pids.join(' ')}`);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  await delay(1_000);
  for (const pid of pids) {
    if (!isPidAlive(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  await delay(200);
};

export const readManagedProcessTable = async (): Promise<ManagedProcessTableEntry[]> => {
  return await new Promise<ManagedProcessTableEntry[]>((resolve) => {
    const child = spawn('ps', ['-axo', 'pid=,command='], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.on('error', () => resolve([]));
    child.on('close', () => {
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
      console.warn(`[MESH] ignoring unreadable child lease ${path}: ${formatError(error)}`);
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

    await killProcessIds(verified, `${spec.name} ${spec.role} process(es)`);
  };

  return {
    leasePathFor,
    readLease,
    writeLease,
    removeLease,
    reapStale,
  };
};
