import { rmSync } from 'fs';
import { join } from 'path';

import { process as processRuntime } from '../../runtime';
import { dbRootPath } from '../../machine/platform';
import type { EntityInput, Env } from '../../types';

export const crashBoundaryFixture = join(import.meta.dir, 'j-submit-crash-boundary-child.ts');

export const cleanupRuntimeStorage = (runtimeId: string): void => {
  const namespacePath = join(dbRootPath, runtimeId);
  rmSync(namespacePath, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-current`, { recursive: true, force: true });
  rmSync(`${namespacePath}-storage-previous`, { recursive: true, force: true });
  rmSync(`${namespacePath}-frames`, { recursive: true, force: true });
  rmSync(`${namespacePath}-events`, { recursive: true, force: true });
  rmSync(`${namespacePath}-infra`, { recursive: true, force: true });
};

export const findJSubmitCrashReplica = (env: Env, entityId: string) => {
  const replica = Array.from(env.eReplicas.values()).find((candidate) => candidate.entityId === entityId);
  if (!replica) throw new Error(`J submit crash fixture replica missing: ${entityId}`);
  return replica;
};

export const processUntilJSubmitCrash = async (
  env: Env,
  initialInputs: EntityInput[],
  expectedMarker: string,
): Promise<void> => {
  let inputs = initialInputs;
  for (let round = 0; round < 20; round += 1) {
    try {
      await processRuntime(env, inputs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(expectedMarker)) throw error;
      return;
    }
    inputs = [];
  }
  throw new Error(`J submit crash boundary not reached: ${expectedMarker}`);
};

export const driveRuntimeUntil = async (
  env: Env,
  predicate: () => boolean,
  label: string,
): Promise<void> => {
  for (let round = 0; round < 20; round += 1) {
    if (predicate()) return;
    await processRuntime(env, []);
  }
  throw new Error(`J submit crash convergence failed: ${label}`);
};
