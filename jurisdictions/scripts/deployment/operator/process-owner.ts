import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { record } from './inputs.ts';

const processStart = (pid: number): string =>
  execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
const errno = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;
type ProcessRow = Readonly<{ pid: number; parent: number; group: number; state: string; executable: string }>;

const processTable = (): ProcessRow[] => {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,comm='], { encoding: 'utf8' })
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) throw new Error('XLN_DEPLOY_PROCESS_TABLE_INVALID');
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        state: match[4]!,
        executable: match[5]!,
      };
    });
  if (!rows.some(row => row.pid === process.pid)) throw new Error('XLN_DEPLOY_PROCESS_TABLE_INVALID');
  return rows;
};

const currentFamily = (rows: readonly ProcessRow[]): Set<number> => {
  const family = new Set([process.pid]);
  let parent = rows.find(row => row.pid === process.pid)?.parent;
  while (parent && !family.has(parent)) {
    family.add(parent);
    parent = rows.find(row => row.pid === parent)?.parent;
  }
  const children = new Set([process.pid]);
  while (rows.some(row => !children.has(row.pid) && children.has(row.parent))) {
    rows.filter(row => children.has(row.parent)).forEach(row => children.add(row.pid));
  }
  return new Set([...family, ...children]);
};

const groupHasExecution = (group: number): boolean => {
  const rows = processTable();
  const excluded = currentFamily(rows);
  // Ignition signs/sends in its Node process; compiler children also retain the
  // lane. A dead launcher PID cannot retire an orphan Node/Bun/solc execution.
  // Shared shell/stand ancestors of this new invocation are not the old owner.
  return rows.some(
    row =>
      row.group === group &&
      !excluded.has(row.pid) &&
      !row.state.startsWith('Z') &&
      /^(?:node|bun|bunx|solc|solcjs)(?:[.-].*)?$/.test(basename(row.executable)),
  );
};

export const deploymentOwner = () => {
  const pgid = Number(execFileSync('ps', ['-p', String(process.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim());
  if (!Number.isSafeInteger(pgid) || pgid <= 0) throw new Error('XLN_DEPLOY_PROCESS_GROUP_INVALID');
  return { pid: process.pid, pgid, host: hostname(), started: processStart(process.pid), token: randomUUID() };
};

export const ownerIsAlive = (value: unknown): boolean => {
  const owner = record(value);
  const pid = owner['pid'];
  const pgid = owner['pgid'];
  if (
    owner['host'] !== hostname() ||
    typeof owner['started'] !== 'string' ||
    typeof owner['token'] !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(owner['token']) ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof pgid !== 'number' ||
    !Number.isSafeInteger(pgid) ||
    pgid <= 0
  )
    throw new Error('XLN_DEPLOY_LOCK_OWNER_INVALID');
  try {
    process.kill(pid, 0);
    if (processStart(pid) !== owner['started']) throw new Error('XLN_DEPLOY_LOCK_PID_REUSED');
    return true;
  } catch (error) {
    if (!errno(error, 'ESRCH')) throw error;
    try {
      processStart(pid);
    } catch (psError) {
      if (psError instanceof Error && 'status' in psError && psError.status === 1) return groupHasExecution(pgid);
      throw psError;
    }
    throw new Error('XLN_DEPLOY_LOCK_PROCESS_CONFLICT');
  }
};
