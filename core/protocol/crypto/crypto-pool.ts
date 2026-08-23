/**
 * Batched pure crypto on worker threads (hub only, optional).
 *
 * Three job kinds, all pure functions of their byte inputs:
 * - `recover`: [32 digest][64 compact sig][1 recovery] records → 20-byte addresses
 * - `sign`:    one private key + N×32 digests → N×65 recoverable signatures
 * - `onion`:   HTLC onion layers (ciphertext, keypair, context) → plaintexts
 *
 * Callers use results only to warm memo caches; the synchronous code path
 * remains the authority, so a dead worker or failed batch costs nothing but
 * the shortcut. Bun-only: the module is imported by shared core and must not
 * touch node built-ins at load time.
 */
import { keccak256Bytes } from './fast-keccak';
import {
  decryptOpaqueHtlcBytes,
  HtlcCiphertextAuthenticationError,
  type OpaqueHtlcCiphertext,
} from '../htlc/multi-recipient';

type BunGlobal = { isMainThread?: boolean };
const bunRuntime = (): BunGlobal | undefined => (globalThis as { Bun?: BunGlobal }).Bun;
type WorkerScope = {
  setOnMessage: (listener: (event: MessageEvent<Job>) => void) => void;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
const workerScope = (): WorkerScope | undefined => {
  if (typeof self === 'undefined' || bunRuntime()?.isMainThread !== false) return undefined;
  const target: unknown = Reflect.get(globalThis, 'self');
  if (target === null || typeof target !== 'object') return undefined;
  const postMessage: unknown = Reflect.get(target, 'postMessage');
  if (typeof postMessage !== 'function') return undefined;
  return {
    setOnMessage: listener => { Reflect.set(target, 'onmessage', listener); },
    postMessage: (value, transfer) => {
      Reflect.apply(postMessage, target, transfer ? [value, transfer] : [value]);
    },
  };
};

export const ECDSA_RECOVER_RECORD_BYTES = 97;
export const ECDSA_RECOVER_RESULT_BYTES = 20;
export const ECDSA_SIGNATURE_BYTES = 65;

type NativeSecp256k1 = {
  ecdsaRecover(signature: Uint8Array, recid: number, message: Uint8Array, compressed: boolean): Uint8Array;
  ecdsaSign(message: Uint8Array, privateKey: Uint8Array): { signature: Uint8Array; recid: number };
};

const loadNative = (): NativeSecp256k1 | null => {
  try {
    return typeof require !== 'undefined' ? (require('secp256k1') as NativeSecp256k1) : null;
  } catch {
    return null;
  }
};

export const recoverBatchSync = (native: NativeSecp256k1, records: Uint8Array): Uint8Array => {
  const count = Math.floor(records.length / ECDSA_RECOVER_RECORD_BYTES);
  const out = new Uint8Array(count * ECDSA_RECOVER_RESULT_BYTES);
  for (let index = 0; index < count; index += 1) {
    const base = index * ECDSA_RECOVER_RECORD_BYTES;
    const recovery = records[base + 96];
    if (recovery !== 0 && recovery !== 1) continue;
    try {
      const publicKey = native.ecdsaRecover(
        records.subarray(base + 32, base + 96),
        recovery,
        records.subarray(base, base + 32),
        false,
      );
      out.set(keccak256Bytes(publicKey.subarray(1)).subarray(12), index * ECDSA_RECOVER_RESULT_BYTES);
    } catch {
      // zero-filled = unrecoverable; the synchronous verifier reports the error.
    }
  }
  return out;
};

const signBatchSync = (native: NativeSecp256k1, privateKey: Uint8Array, digests: Uint8Array): Uint8Array => {
  const count = Math.floor(digests.length / 32);
  const out = new Uint8Array(count * ECDSA_SIGNATURE_BYTES);
  for (let index = 0; index < count; index += 1) {
    const { signature, recid } = native.ecdsaSign(digests.subarray(index * 32, index * 32 + 32), privateKey);
    out.set(signature, index * ECDSA_SIGNATURE_BYTES);
    out[index * ECDSA_SIGNATURE_BYTES + 64] = recid;
  }
  return out;
};

export type OnionJobItem = Readonly<{
  ciphertext: OpaqueHtlcCiphertext;
  publicKey: string;
  privateKey: string;
  contextHash: string;
}>;
/** Plaintext, or the failure class the synchronous path would report. */
export type OnionJobResult = Uint8Array | 'auth' | 'invalid';

const onionBatchSync = (items: readonly OnionJobItem[]): OnionJobResult[] => items.map(item => {
  try {
    return decryptOpaqueHtlcBytes(item.ciphertext, item.publicKey, item.privateKey, item.contextHash);
  } catch (error) {
    return error instanceof HtlcCiphertextAuthenticationError ? 'auth' : 'invalid';
  }
});

type Job =
  | { id: number; kind: 'recover'; records: Uint8Array }
  | { id: number; kind: 'sign'; privateKey: Uint8Array; digests: Uint8Array }
  | { id: number; kind: 'onion'; items: OnionJobItem[] };
type JobResult = { id: number; result: Uint8Array | OnionJobResult[] };

const scope = workerScope();
if (scope && process.env['XLN_CRYPTO_POOL_WORKER'] === '1') {
  const native = loadNative();
  scope.setOnMessage((event: MessageEvent<Job>) => {
    const job = event.data;
    if (job.kind === 'onion') {
      scope.postMessage({ id: job.id, result: onionBatchSync(job.items) } satisfies JobResult);
      return;
    }
    const result = !native
      ? new Uint8Array(0)
      : job.kind === 'recover'
        ? recoverBatchSync(native, job.records)
        : signBatchSync(native, job.privateKey, job.digests);
    scope.postMessage({ id: job.id, result } satisfies JobResult, [result.buffer as ArrayBuffer]);
  });
}

let pool: Worker[] | null | undefined;
let nextJobId = 0;
let nextSlot = 0;
const pending = new Map<number, (result: JobResult['result']) => void>();

const poolSize = (): number => {
  const raw = process.env['XLN_CRYPTO_POOL_WORKERS'];
  const configured = raw === undefined || raw === '' ? NaN : Number(raw);
  if (Number.isSafeInteger(configured) && configured >= 0) return configured;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
  return Math.max(0, Math.min(8, (cores || 2) - 2));
};

/** A dead worker fails every in-flight job closed: callers fall back to the sync path. */
const retirePool = (): void => {
  for (const worker of pool ?? []) worker.terminate();
  pool = null;
  const failed = [...pending.values()];
  pending.clear();
  for (const resolve of failed) resolve(new Uint8Array(0));
};

const getPool = (): Worker[] | null => {
  if (pool !== undefined) return pool;
  const size = poolSize();
  if (size === 0 || bunRuntime()?.isMainThread !== true || typeof Worker === 'undefined') {
    pool = null;
    return pool;
  }
  pool = Array.from({ length: size }, () => {
    const worker = new Worker(new URL(import.meta.url), {
      env: { ...process.env, XLN_CRYPTO_POOL_WORKER: '1' },
    } as WorkerOptions);
    worker.onmessage = event => {
      const { id, result } = event.data as JobResult;
      const resolve = pending.get(id);
      if (!resolve) return;
      pending.delete(id);
      resolve(result);
    };
    worker.onerror = retirePool;
    worker.addEventListener('close', retirePool);
    const unref = Reflect.get(worker, 'unref');
    if (typeof unref === 'function') Reflect.apply(unref, worker, []);
    return worker;
  });
  return pool;
};

export const cryptoPoolEnabled = (): boolean => getPool() !== null;

const submit = (workers: Worker[], job: Job, transfer?: Transferable[]): Promise<JobResult['result']> =>
  new Promise(resolve => {
    const worker = workers[nextSlot % workers.length];
    nextSlot += 1;
    if (!worker) throw new Error('CRYPTO_POOL_WORKER_SLOT_MISSING');
    pending.set(job.id, resolve);
    worker.postMessage(job, transfer ?? []);
  });

const isBytes = (value: JobResult['result']): value is Uint8Array => value instanceof Uint8Array;

/**
 * Recover all records across the pool. Returns packed 20-byte addresses in
 * input order, or null when no pool is available (caller falls back to sync).
 */
export const recoverAddressesBatch = async (records: Uint8Array): Promise<Uint8Array | null> => {
  const workers = getPool();
  if (!workers) return null;
  const count = Math.floor(records.length / ECDSA_RECOVER_RECORD_BYTES);
  if (count === 0) return new Uint8Array(0);
  const perWorker = Math.ceil(count / workers.length);
  const parts: Promise<{ offset: number; result: JobResult['result'] }>[] = [];
  for (let start = 0; start < count; start += perWorker) {
    const end = Math.min(count, start + perWorker);
    // Own buffer per job so the transfer list detaches only this slice.
    const slice = records.slice(start * ECDSA_RECOVER_RECORD_BYTES, end * ECDSA_RECOVER_RECORD_BYTES);
    const id = nextJobId += 1;
    parts.push(submit(workers, { id, kind: 'recover', records: slice }, [slice.buffer as ArrayBuffer])
      .then(result => ({ offset: start, result })));
  }
  const out = new Uint8Array(count * ECDSA_RECOVER_RESULT_BYTES);
  for (const { offset, result } of await Promise.all(parts)) {
    if (!isBytes(result) || result.length === 0) return null;
    out.set(result, offset * ECDSA_RECOVER_RESULT_BYTES);
  }
  return out;
};

/** Sign N digests with one key; 65-byte recoverable signatures in input order, or null. */
export const signDigestsBatch = async (privateKey: Uint8Array, digests: Uint8Array): Promise<Uint8Array | null> => {
  const workers = getPool();
  if (!workers) return null;
  const count = Math.floor(digests.length / 32);
  if (count === 0) return new Uint8Array(0);
  const perWorker = Math.ceil(count / workers.length);
  const parts: Promise<{ offset: number; result: JobResult['result'] }>[] = [];
  for (let start = 0; start < count; start += perWorker) {
    const end = Math.min(count, start + perWorker);
    const slice = digests.slice(start * 32, end * 32);
    const id = nextJobId += 1;
    parts.push(submit(workers, { id, kind: 'sign', privateKey: privateKey.slice(), digests: slice }, [slice.buffer as ArrayBuffer])
      .then(result => ({ offset: start, result })));
  }
  const out = new Uint8Array(count * ECDSA_SIGNATURE_BYTES);
  for (const { offset, result } of await Promise.all(parts)) {
    if (!isBytes(result) || result.length === 0) return null;
    out.set(result, offset * ECDSA_SIGNATURE_BYTES);
  }
  return out;
};

/** Decrypt onion layers across the pool; results in input order, or null. */
export const decryptOnionLayersBatch = async (items: readonly OnionJobItem[]): Promise<OnionJobResult[] | null> => {
  const workers = getPool();
  if (!workers || items.length === 0) return workers ? [] : null;
  const perWorker = Math.ceil(items.length / workers.length);
  const parts: Promise<{ offset: number; result: JobResult['result'] }>[] = [];
  for (let start = 0; start < items.length; start += perWorker) {
    const id = nextJobId += 1;
    parts.push(submit(workers, { id, kind: 'onion', items: items.slice(start, start + perWorker) })
      .then(result => ({ offset: start, result })));
  }
  const out: OnionJobResult[] = new Array(items.length);
  for (const { offset, result } of await Promise.all(parts)) {
    if (isBytes(result)) return null;
    for (const [index, value] of result.entries()) out[offset + index] = value;
  }
  return out;
};
