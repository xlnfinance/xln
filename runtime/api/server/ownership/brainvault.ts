/**
 * Node custody boundary for BrainVault.
 *
 * BrainVault input arrives only through an authenticated admin radapter. This
 * module derives outside the deterministic Runtime machine, writes the mnemonic
 * to a mode-0600 operator file, registers the matching private key in the
 * Runtime's memory-only signer store, and commits only the public Entity import.
 * Putting a passphrase, mnemonic or private key into RuntimeInput would copy it
 * into the WAL forever, so that tempting shortcut is explicitly forbidden.
 */

import { availableParallelism, totalmem } from 'node:os';
import { chmodSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { getBytes } from 'ethers';
import {
  deriveBrainVaultNative,
  type BrainVaultNativeProgress,
} from '../../../../brainvault/native.ts';
import { deriveEthereumAddress, deriveEthereumPrivateKeyAtPath } from '../../../../brainvault/core.ts';
import { BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID } from '../../../../brainvault/spec.ts';
import { registerSignerKey } from '../../../account/crypto';
import type { RuntimeInput, RuntimeReplica } from '../../../runtime/types';
import { buildLocalRuntimeOwner, ensureLocalRuntimeOwner } from './local-runtime';
import type {
  RuntimeAdapterBrainVaultInput,
  RuntimeAdapterBrainVaultRecovery,
  RuntimeAdapterBrainVaultResult,
} from '../../runtime-adapter/types';
import {
  fsyncStorageParentDirectory,
  type StorageDurabilityOptions,
} from '../../../storage/fs-durability';

type StoredBrainVaultOwner = Readonly<{
  version: 1;
  specId: typeof BRAINVAULT_V1_SPEC_ID;
  mnemonic24: string;
  ethereumAddress: string;
}>;

export type BrainVaultOwnerController = Readonly<{
  deriveAndInstall(
    env: RuntimeReplica,
    input: RuntimeAdapterBrainVaultInput,
    options: Readonly<{ signal: AbortSignal; onProgress: (progress: BrainVaultNativeProgress) => void }>,
  ): Promise<RuntimeAdapterBrainVaultResult>;
  revealMnemonic(): Promise<RuntimeAdapterBrainVaultRecovery>;
  /** Register the persisted signer before Runtime WAL replay begins. */
  prewarm(runtimeSeed: Uint8Array | string): Promise<boolean>;
  restore(env: RuntimeReplica): Promise<RuntimeAdapterBrainVaultResult | null>;
}>;

type BrainVaultOwnerControllerDeps = Readonly<{
  path: string;
  /** Built distributions supply the isolated native worker beside server.js. */
  workerPath?: string;
  profileName: string;
  enqueue: (env: RuntimeReplica, input: RuntimeInput) => void;
  onFrameCommit: (env: RuntimeReplica, callback: (height: number) => void) => () => void;
  timeoutMs: number;
  /** Fault-boundary injection for real filesystem durability tests. */
  durability?: StorageDurabilityOptions;
}>;

const normalizeStoredOwner = async (value: unknown): Promise<StoredBrainVaultOwner> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BRAINVAULT_OWNER_FILE_INVALID');
  const owner = value as Record<string, unknown>;
  if (owner['version'] !== 1 || owner['specId'] !== BRAINVAULT_V1_SPEC_ID) {
    throw new Error('BRAINVAULT_OWNER_SPEC_MISMATCH');
  }
  const mnemonic24 = String(owner['mnemonic24'] || '');
  const ethereumAddress = String(owner['ethereumAddress'] || '').toLowerCase();
  if (mnemonic24.trim().split(/\s+/).length !== 24 || !/^0x[0-9a-f]{40}$/.test(ethereumAddress)) {
    throw new Error('BRAINVAULT_OWNER_FILE_INVALID');
  }
  const derived = (await deriveEthereumAddress(mnemonic24)).toLowerCase();
  if (derived !== ethereumAddress) throw new Error('BRAINVAULT_OWNER_ADDRESS_MISMATCH');
  return { version: 1, specId: BRAINVAULT_V1_SPEC_ID, mnemonic24, ethereumAddress };
};

const readOwner = async (path: string): Promise<StoredBrainVaultOwner | null> => {
  try {
    const owner = await normalizeStoredOwner(JSON.parse(readFileSync(path, 'utf8')));
    chmodSync(path, 0o600);
    return owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
};

const requireOwnerParentDurable = async (
  path: string,
  durability: StorageDurabilityOptions = {},
): Promise<void> => {
  const result = await fsyncStorageParentDirectory(path, durability);
  if (result.status === 'unsupported') {
    throw new Error(`BRAINVAULT_OWNER_DIRECTORY_FSYNC_UNSUPPORTED:${result.code}`);
  }
};

/**
 * Publish the custody secret only after its complete body is durable.
 *
 * A fixed temp name makes one interrupted write permanently block recovery;
 * renaming before fsync can publish a torn owner after power loss; and omitting
 * the parent-directory fsync can lose the rename itself. A random same-folder
 * temp plus write -> file fsync -> rename -> directory fsync closes all three
 * failure windows while keeping the final file atomic and mode 0600.
 */
const persistOwner = async (
  path: string,
  owner: StoredBrainVaultOwner,
  durability: StorageDurabilityOptions = {},
): Promise<void> => {
  const fs = await import('node:fs/promises');
  const parent = dirname(path);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(`${JSON.stringify(owner)}\n`, { encoding: 'utf8' });
      await durability.onBoundary?.('after-file-write');
      await (durability.syncFile ?? (handle => handle.sync()))(file);
      await durability.onBoundary?.('after-file-sync');
    } finally {
      await file.close();
    }
    await fs.rename(temporary, path);
    await durability.onBoundary?.('after-file-rename');
    await requireOwnerParentDurable(path, durability);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], 'BRAINVAULT_OWNER_PERSIST_AND_CLEANUP_FAILED');
      }
    }
    throw error;
  }
};

const nativeWorkerCap = (requested: number): number => {
  const memoryWorkers = Math.max(1, Math.floor((totalmem() * 0.75) / (BRAINVAULT_V1.SHARD_MEMORY_KB * 1024)));
  return Math.max(1, Math.min(requested, availableParallelism(), memoryWorkers, 256));
};

export const createBrainVaultOwnerController = (
  deps: BrainVaultOwnerControllerDeps,
): BrainVaultOwnerController => {
  // One node has exactly one owner slot. Serialize it across admin sockets so
  // two expensive recoveries cannot race the no-overwrite custody decision.
  let ownerOperationActive = false;
  const runOwnerOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (ownerOperationActive) throw new Error('BRAINVAULT_OWNER_OPERATION_PENDING');
    ownerOperationActive = true;
    try {
      return await operation();
    } finally {
      ownerOperationActive = false;
    }
  };
  const requirePath = (): string => {
    const path = String(deps.path || '').trim();
    if (!path) throw new Error('BRAINVAULT_OWNER_PATH_NOT_CONFIGURED');
    return path;
  };

  const install = async (
    env: RuntimeReplica,
    stored: StoredBrainVaultOwner,
  ): Promise<{ entityId: string; created: boolean; height: number }> => {
    await registerStoredSigner(env, stored);
    const jurisdictionName = String(env.activeJurisdiction || 'local');
    const jurisdiction = env.state.jReplicas.get(jurisdictionName);
    if (!jurisdiction) throw new Error(`BRAINVAULT_OWNER_JURISDICTION_MISSING:${jurisdictionName}`);
    const owner = buildLocalRuntimeOwner({
      signerId: stored.ethereumAddress,
      profileName: deps.profileName,
      jurisdictionName,
      jurisdiction,
    });
    return ensureLocalRuntimeOwner(env, owner, {
      enqueue: deps.enqueue,
      onFrameCommit: deps.onFrameCommit,
      timeoutMs: deps.timeoutMs,
    });
  };

  async function registerStoredSigner(
    scope: RuntimeReplica | Uint8Array | string,
    stored: StoredBrainVaultOwner,
  ): Promise<void> {
    const privateKey = await deriveEthereumPrivateKeyAtPath(stored.mnemonic24, "m/44'/60'/0'/0/0");
    registerSignerKey(scope, stored.ethereumAddress, getBytes(privateKey));
  }

  return {
    async deriveAndInstall(env, input, options) {
      return runOwnerOperation(async () => {
        if (input.specId !== BRAINVAULT_V1_SPEC_ID) {
          throw new Error(`BRAINVAULT_SPEC_MISMATCH:${input.specId}:${BRAINVAULT_V1_SPEC_ID}`);
        }
        const path = requirePath();
        const workers = nativeWorkerCap(input.workers);
        const result = await deriveBrainVaultNative(
          { ...input, workers },
          { ...options, ...(deps.workerPath ? { workerPath: deps.workerPath } : {}) },
        );
        const stored: StoredBrainVaultOwner = {
          version: 1,
          specId: BRAINVAULT_V1_SPEC_ID,
          mnemonic24: result.mnemonic24,
          ethereumAddress: result.ethereumAddress.toLowerCase(),
        };
        const existing = await readOwner(path);
        if (existing && existing.ethereumAddress !== stored.ethereumAddress) {
          throw new Error(`BRAINVAULT_OWNER_ALREADY_CONFIGURED:${existing.ethereumAddress}`);
        }
        if (existing) await requireOwnerParentDurable(path, deps.durability);
        else await persistOwner(path, stored, deps.durability);
        const installed = await install(env, existing ?? stored);
        return {
          specId: result.specId,
          backend: result.backend,
          shardCount: result.shardCount,
          factor: result.factor,
          workers: result.workers,
          derivationTimeMs: result.derivationTimeMs,
          ethereumAddress: result.ethereumAddress,
          entityId: installed.entityId,
          created: installed.created,
          height: installed.height,
        };
      });
    },

    async revealMnemonic() {
      const owner = await readOwner(requirePath());
      if (!owner) throw new Error('BRAINVAULT_OWNER_NOT_CONFIGURED');
      return { mnemonic24: owner.mnemonic24 };
    },

    async prewarm(runtimeSeed) {
      const path = requirePath();
      const owner = await readOwner(path);
      if (!owner) return false;
      await requireOwnerParentDurable(path, deps.durability);
      // WAL replay can contain signed Entity inputs for this owner. Registering
      // after main() is too late: replay correctly fails on a missing key.
      await registerStoredSigner(runtimeSeed, owner);
      return true;
    },

    async restore(env) {
      return runOwnerOperation(async () => {
        const path = requirePath();
        const owner = await readOwner(path);
        if (!owner) return null;
        await requireOwnerParentDurable(path, deps.durability);
        const installed = await install(env, owner);
        return {
          specId: owner.specId,
          backend: 'native-node',
          shardCount: 0,
          factor: 0,
          workers: 0,
          derivationTimeMs: 0,
          ethereumAddress: owner.ethereumAddress,
          entityId: installed.entityId,
          created: installed.created,
          height: installed.height,
        };
      });
    },
  };
};
