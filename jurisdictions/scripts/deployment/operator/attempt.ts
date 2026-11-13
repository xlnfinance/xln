import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { save } from '../manifest.cjs';
import { record } from './inputs.ts';

const processStart = (pid: number): string => execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
const errno = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;

const ownerIsAlive = (value: unknown): boolean => {
  const owner = record(value);
  const pid = owner['pid'];
  if (owner['host'] !== hostname() || typeof owner['started'] !== 'string' || typeof owner['token'] !== 'string'
    || !/^[0-9a-f-]{36}$/.test(owner['token'])
    || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('XLN_DEPLOY_LOCK_OWNER_INVALID');
  try {
    process.kill(pid, 0);
    if (processStart(pid) !== owner['started']) throw new Error('XLN_DEPLOY_LOCK_PID_REUSED');
    return true;
  } catch (error) {
    if (!errno(error, 'ESRCH')) throw error;
    try { processStart(pid); } catch (psError) {
      if (psError instanceof Error && 'status' in psError && psError.status === 1) return false;
      throw psError;
    }
    throw new Error('XLN_DEPLOY_LOCK_PROCESS_CONFLICT');
  }
};

export const acquireDeploymentLane = async (root: string, chainId: number, signer: string): Promise<() => Promise<void>> => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${chainId}-${signer.toLowerCase()}`);
  const ownerPath = join(path, 'owner.json');
  const owner = { pid: process.pid, host: hostname(), started: processStart(process.pid), token: randomUUID() };
  for (let retry = 0; retry < 2; retry++) {
    try {
      await mkdir(path, { mode: 0o700 });
      save(ownerPath, owner);
      return async () => {
        const saved = record(JSON.parse(await readFile(ownerPath, 'utf8')));
        if (saved['token'] !== owner.token) throw new Error('XLN_DEPLOY_LOCK_OWNERSHIP_CHANGED');
        await rm(path, { recursive: true });
      };
    } catch (error) {
      if (!errno(error, 'EEXIST')) throw error;
      const prior = record(JSON.parse(await readFile(ownerPath, 'utf8')));
      if (ownerIsAlive(prior)) throw new Error('XLN_DEPLOY_SIGNER_CHAIN_ACTIVE');
      // Keep the token-specific nonempty tombstone: a second stale observer
      // cannot rename/delete a newly acquired live lane into the same target.
      const retired = join(root, 'interrupted');
      await mkdir(retired, { recursive: true, mode: 0o700 });
      await rename(path, join(retired, String(prior['token'])));
    }
  }
  throw new Error('XLN_DEPLOY_SIGNER_CHAIN_ACTIVE');
};

export const createInvocation = async (directory: string, identity: object) => {
  let previous: unknown;
  try { previous = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')); }
  catch (error) { if (!errno(error, 'ENOENT')) throw error; }
  if (previous !== undefined) {
    const prior = record(previous);
    if (prior['status'] === 'running') {
      const path = prior['invocation'];
      if (typeof path !== 'string' || dirname(path) !== join(directory, 'invocations')) throw new Error('XLN_DEPLOY_INVOCATION_INVALID');
      if (ownerIsAlive(prior['owner'])) throw new Error('XLN_DEPLOY_INVOCATION_ACTIVE');
      save(join(path, 'result.json'), { ...prior, status: 'interrupted' });
    }
  }
  const invocation = join(directory, 'invocations', randomUUID());
  await mkdir(invocation, { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, host: hostname(), started: processStart(process.pid), token: randomUUID() };
  const write = (outcome: object): void => {
    const value = { ...identity, invocation, ownerPid: process.pid, owner, ...outcome };
    save(join(invocation, 'result.json'), value);
    save(join(directory, 'result.json'), value);
  };
  write({ status: 'running', phase: 'deploying' });
  return { write };
};
