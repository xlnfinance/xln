import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { save } from '../manifest.cjs';
import { record } from './inputs.ts';
import { deploymentOwner, ownerIsAlive } from './process-owner.ts';

const errno = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

const acquireLock = async (root: string, key: string, activeError: string): Promise<() => Promise<void>> => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, key);
  const ownerPath = join(path, 'owner.json');
  const owner = deploymentOwner();
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
      if (ownerIsAlive(prior)) throw new Error(activeError);
      // Keep the token-specific nonempty tombstone: a second stale observer
      // cannot rename/delete a newly acquired live lane into the same target.
      const retired = join(root, 'interrupted');
      await mkdir(retired, { recursive: true, mode: 0o700 });
      try {
        await rename(path, join(retired, String(prior['token'])));
      } catch (retirementError) {
        if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].some(code => errno(retirementError, code))) {
          throw new Error(activeError, { cause: retirementError });
        }
        throw retirementError;
      }
    }
  }
  throw new Error(activeError);
};

export const acquireDeploymentLane = async (
  root: string,
  chainId: number,
  signer: string,
  deploymentId: string,
): Promise<() => Promise<void>> => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(deploymentId)) throw new Error('XLN_DEPLOYMENT_ID_INVALID');
  // Attempt identity survives parameter/output changes. A different signer
  // cannot acquire the same active attempt through a separate nonce lane.
  const releaseAttempt = await acquireLock(join(root, 'attempts'), `deployment-${deploymentId}`, 'XLN_DEPLOY_ATTEMPT_ACTIVE');
  try {
    const releaseLane = await acquireLock(root, `${chainId}-${signer.toLowerCase()}`, 'XLN_DEPLOY_SIGNER_CHAIN_ACTIVE');
    return async () => {
      try {
        await releaseLane();
      } finally {
        await releaseAttempt();
      }
    };
  } catch (error) {
    await releaseAttempt();
    throw error;
  }
};

export const createInvocation = async (directory: string, identity: object) => {
  let previous: unknown;
  try {
    previous = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  } catch (error) {
    if (!errno(error, 'ENOENT')) throw error;
  }
  if (previous !== undefined) {
    const prior = record(previous);
    if (prior['status'] === 'running') {
      const path = prior['invocation'];
      if (typeof path !== 'string' || dirname(path) !== join(directory, 'invocations'))
        throw new Error('XLN_DEPLOY_INVOCATION_INVALID');
      if (ownerIsAlive(prior['owner'])) throw new Error('XLN_DEPLOY_INVOCATION_ACTIVE');
      const archivePath = join(path, 'result.json');
      const archived = record(JSON.parse(await readFile(archivePath, 'utf8')));
      const sameIdentity = ['invocation', 'ownerPid', 'deploymentId', 'chainId', 'mode']
        .every(key => archived[key] === prior[key]);
      if (!sameIdentity || record(archived['owner'])['token'] !== record(prior['owner'])['token'])
        throw new Error('XLN_DEPLOY_INVOCATION_INVALID');
      // The invocation is persisted before the root summary. A crash between
      // those renames leaves a running root beside a durable terminal archive;
      // that stale summary must never erase the completed/failed evidence.
      const status = archived['status'];
      if (status === 'running') save(archivePath, { ...archived, status: 'interrupted' });
      else if (typeof status !== 'string' || !['complete', 'failed', 'interrupted'].includes(status))
        throw new Error('XLN_DEPLOY_INVOCATION_INVALID');
    }
  }
  const invocation = join(directory, 'invocations', randomUUID());
  await mkdir(invocation, { recursive: true, mode: 0o700 });
  const owner = deploymentOwner();
  const write = (outcome: object): void => {
    const value = { ...identity, invocation, ownerPid: process.pid, owner, ...outcome };
    save(join(invocation, 'result.json'), value);
    save(join(directory, 'result.json'), value);
  };
  write({ status: 'running', phase: 'deploying' });
  return { write };
};
