/**
 * Canonical node-side BrainVault derivation.
 *
 * This is the only orchestration path allowed for a Runtime hosted by Bun. It
 * deliberately consumes the same salts, factor mapping, domain tag and BIP-39
 * encoder as the browser path; the only substitution is the audited native
 * Argon2 implementation. A backend is an execution choice, never a wallet
 * format choice: identical V1 inputs must produce identical bytes everywhere.
 *
 * Secrets returned here are intentionally short-lived. Callers own persistence
 * and disclosure policy and must never log this result or place it in Runtime
 * inputs/WAL. The radapter server persists the mnemonic for its local signer;
 * ordinary derivation returns only public identity, while a separate explicit
 * admin action may reveal that mnemonic to the connected browser.
 *
 * AUDITOR NOTE — worker isolation is part of correctness, not an optimization.
 * Concurrent `hashRaw` calls inside one Bun isolate were observed to corrupt
 * later shard results. Every parallel Argon2 call therefore runs in its own
 * worker-thread isolate. Do not "simplify" this pool to `Promise.all`: the
 * multi-worker frozen vector exists specifically to catch that regression.
 */

import { hashRaw as argon2Native } from '@node-rs/argon2';
import { Worker } from 'node:worker_threads';
import {
  combineShards,
  deriveEthereumAddress,
  deriveKey,
  entropyToMnemonic,
  factorForShardCount,
  getShardCount,
} from './core.ts';
import {
  assertBrainVaultName,
  assertBrainVaultPassphrase,
  BRAINVAULT_V1,
  BRAINVAULT_V1_SPEC_ID,
  createShardSalt,
} from './primitives/spec.ts';
import { hexToBytes } from './primitives/encoding.ts';

export type BrainVaultNativeInput = Readonly<{
  name: string;
  passphrase: string;
  /** Presets 1..5 map to 10^(factor-1); values >=6 are literal shard counts. */
  shardInput: number;
  workers: number;
}>;

export type BrainVaultNativeProgress = Readonly<{
  completed: number;
  total: number;
  elapsedMs: number;
  lastShardMs: number;
  workers: number;
}>;

export type BrainVaultNativeResult = Readonly<{
  specId: typeof BRAINVAULT_V1_SPEC_ID;
  backend: 'native-node';
  shardCount: number;
  factor: number;
  workers: number;
  derivationTimeMs: number;
  mnemonic24: string;
  ethereumAddress: string;
}>;

export type BrainVaultNativeOptions = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: BrainVaultNativeProgress) => void;
  /** Bundled distributions pass their built worker; source runs use the TS file. */
  workerPath?: string;
}>;

const abortError = (): Error => new Error('BRAINVAULT_DERIVATION_ABORTED');

const requireNotAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw abortError();
};

const validateInput = (input: BrainVaultNativeInput): { shardCount: number; factor: number; workers: number } => {
  assertBrainVaultName(input.name);
  assertBrainVaultPassphrase(input.passphrase);
  // No upper bound by design: the work factor must be able to track hardware for
  // decades, so a caller who wants a year-long derivation is allowed to have one.
  // These checks are type safety (Array(NaN), negative counts), not policy, and
  // they match cli.ts exactly so both entry points accept the same inputs.
  if (!Number.isSafeInteger(input.shardInput) || input.shardInput < 1) {
    throw new Error(`BRAINVAULT_SHARD_INPUT_INVALID:${String(input.shardInput)}`);
  }
  if (!Number.isSafeInteger(input.workers) || input.workers < 1) {
    throw new Error(`BRAINVAULT_WORKER_COUNT_INVALID:${String(input.workers)}`);
  }
  const preset = input.shardInput <= 5;
  const shardCount = preset ? getShardCount(input.shardInput) : input.shardInput;
  return {
    shardCount,
    factor: preset ? input.shardInput : factorForShardCount(shardCount),
    workers: Math.min(input.workers, shardCount),
  };
};

/** Native equivalent of kdf.ts; kept public so the CLI worker cannot drift. */
export const deriveBrainVaultNativeShard = async (
  input: BrainVaultNativeInput,
  shardIndex: number,
  shardCount: number,
): Promise<Uint8Array> => {
  assertBrainVaultName(input.name);
  assertBrainVaultPassphrase(input.passphrase);
  const salt = await createShardSalt(input.name, shardIndex, shardCount);
  const password = new TextEncoder().encode(input.passphrase.normalize('NFKD'));
  try {
    const output = await argon2Native(password, {
      salt: Buffer.from(salt),
      memoryCost: BRAINVAULT_V1.SHARD_MEMORY_KB,
      timeCost: BRAINVAULT_V1.ARGON_TIME_COST,
      parallelism: BRAINVAULT_V1.ARGON_PARALLELISM,
      outputLen: BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
      algorithm: 2, // @node-rs/argon2 Algorithm.Argon2id.
      version: 1, // @node-rs/argon2 Version.V0x13; part of BRAINVAULT_V1_SPEC_ID.
    });
    return new Uint8Array(output);
  } finally {
    password.fill(0);
  }
};

/** Derive one complete V1 wallet with bounded native concurrency. */
export const deriveBrainVaultNative = async (
  input: BrainVaultNativeInput,
  options: BrainVaultNativeOptions = {},
): Promise<BrainVaultNativeResult> => {
  const { shardCount, factor, workers } = validateInput(input);
  const startedAt = performance.now();
  const shards = new Array<Uint8Array>(shardCount);
  let nextShard = 0;
  let completed = 0;
  const workerPath = options.workerPath ?? `${import.meta.dir}/worker-native.ts`;
  const pool: Worker[] = [];
  const assignedAt = new Map<Worker, number>();

  const deriveShards = async (): Promise<void> => {
    requireNotAborted(options.signal);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const terminate = (): Promise<void> => Promise.all(pool.map(worker => worker.terminate())).then(() => undefined);
      const cleanup = (): void => options.signal?.removeEventListener('abort', abort);
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const cause = error instanceof Error ? error : new Error(String(error));
        void terminate().then(
          () => reject(cause),
          terminationError => reject(new AggregateError([cause, terminationError], 'BRAINVAULT_WORKER_FAILURE')),
        );
      };
      const abort = (): void => fail(abortError());
      const dispatch = (worker: Worker): void => {
        const shardIndex = nextShard++;
        if (shardIndex >= shardCount) return;
        assignedAt.set(worker, performance.now());
        worker.postMessage({
          specId: BRAINVAULT_V1_SPEC_ID,
          name: input.name,
          passphrase: input.passphrase,
          shardIndex,
          shardCount,
        });
      };

      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        for (let index = 0; index < workers; index += 1) {
          const worker = new Worker(workerPath);
          pool.push(worker);
          worker.on('error', fail);
          worker.on('exit', code => {
            if (!settled && completed < shardCount) fail(new Error(`BRAINVAULT_WORKER_EXITED:${code}`));
          });
          worker.on('message', (message: unknown) => {
            if (settled) return;
            const record = message && typeof message === 'object' ? message as Record<string, unknown> : null;
            const workerSpecId = record?.['specId'];
            if (workerSpecId !== BRAINVAULT_V1_SPEC_ID) {
              fail(new Error(
                `BRAINVAULT_WORKER_SPEC_MISMATCH:${String(workerSpecId)}:${BRAINVAULT_V1_SPEC_ID}`,
              ));
              return;
            }
            const shardIndex = record?.['shardIndex'];
            const result = record?.['result'];
            if (!Number.isSafeInteger(shardIndex) || Number(shardIndex) < 0 || Number(shardIndex) >= shardCount) {
              fail(new Error(`BRAINVAULT_WORKER_SHARD_INDEX_INVALID:${String(shardIndex)}`));
              return;
            }
            const exactIndex = Number(shardIndex);
            if (shards[exactIndex] !== undefined) {
              fail(new Error(`BRAINVAULT_WORKER_SHARD_DUPLICATE:${exactIndex}`));
              return;
            }
            if (typeof result !== 'string' || result.length !== BRAINVAULT_V1.SHARD_OUTPUT_BYTES * 2) {
              fail(new Error(`BRAINVAULT_WORKER_RESULT_INVALID:${exactIndex}`));
              return;
            }
            try {
              shards[exactIndex] = hexToBytes(result);
            } catch (error) {
              fail(error);
              return;
            }
            const progressAt = performance.now();
            const workerStartedAt = assignedAt.get(worker) ?? progressAt;
            assignedAt.delete(worker);
            completed += 1;
            try {
              options.onProgress?.({
                completed,
                total: shardCount,
                elapsedMs: Math.round(progressAt - startedAt),
                lastShardMs: Math.round(progressAt - workerStartedAt),
                workers,
              });
            } catch (error) {
              fail(error);
              return;
            }
            if (completed === shardCount) {
              settled = true;
              cleanup();
              void terminate().then(resolve, reject);
            } else {
              dispatch(worker);
            }
          });
          dispatch(worker);
        }
      } catch (error) {
        fail(error);
      }
    });
  };

  try {
    await deriveShards();
    requireNotAborted(options.signal);
    for (let index = 0; index < shardCount; index += 1) {
      if (!(shards[index] instanceof Uint8Array)) throw new Error(`BRAINVAULT_NATIVE_SHARD_MISSING:${index}`);
    }
    const masterKey = await combineShards(shards, factor);
    try {
      const entropy24 = await deriveKey(masterKey, 'bip39/entropy/v1.0', 32);
      const mnemonic24 = await entropyToMnemonic(entropy24);
      const ethereumAddress = await deriveEthereumAddress(mnemonic24);
      entropy24.fill(0);
      return {
        specId: BRAINVAULT_V1_SPEC_ID,
        backend: 'native-node',
        shardCount,
        factor,
        workers,
        derivationTimeMs: Math.round(performance.now() - startedAt),
        mnemonic24,
        ethereumAddress,
      };
    } finally {
      masterKey.fill(0);
    }
  } finally {
    for (const shard of shards) shard?.fill(0);
  }
};
