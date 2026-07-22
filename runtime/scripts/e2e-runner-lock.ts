import { readFileSync } from 'node:fs';

export type E2ERunnerLock = {
  pid: number;
  startedAt: number;
  cwd: string;
  logsDir?: string;
};

const invalidLock = (path: string, detail: string): Error =>
  new Error(`RUNNER_LOCK_INVALID:path=${path}:${detail}`);

export const parseE2ERunnerLock = (raw: string, path: string): E2ERunnerLock => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalidLock(path, error instanceof Error ? error.message : String(error));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidLock(path, 'body must be an object');
  }
  const body = parsed as Record<string, unknown>;
  const pid = Number(body['pid']);
  const startedAt = Number(body['startedAt']);
  const cwd = typeof body['cwd'] === 'string' ? body['cwd'].trim() : '';
  const logsDir = body['logsDir'];
  if (!Number.isSafeInteger(pid) || pid <= 0) throw invalidLock(path, 'pid must be a positive safe integer');
  if (!Number.isFinite(startedAt) || startedAt <= 0) throw invalidLock(path, 'startedAt must be positive');
  if (!cwd) throw invalidLock(path, 'cwd is required');
  if (logsDir !== undefined && (typeof logsDir !== 'string' || !logsDir.trim())) {
    throw invalidLock(path, 'logsDir must be a non-empty string');
  }
  return { pid, startedAt, cwd, ...(typeof logsDir === 'string' ? { logsDir: logsDir.trim() } : {}) };
};

export const readE2ERunnerLock = (path: string): E2ERunnerLock | null => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`RUNNER_LOCK_READ_FAILED:path=${path}:${String(error)}`);
  }
  return parseE2ERunnerLock(raw, path);
};

export const isE2ERunnerProcessAlive = (
  pid: number,
  probe: (pid: number, signal: 0) => void = process.kill,
): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`RUNNER_PROCESS_PID_INVALID:${pid}`);
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error(`RUNNER_PROCESS_PROBE_FAILED:pid=${pid}:${String(error)}`);
  }
};
