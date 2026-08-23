/**
 * Batched ECDSA public-key recovery on worker threads.
 *
 * The hub verifies two secp256k1 signatures per inbound Account input (frame
 * hanko + dispute-seal hanko), ~100 µs each on the main thread. Every digest is
 * already on the wire, so recovery needs no state: this pool ships flat byte
 * records to workers (transferable, zero copy), each worker runs the native
 * libsecp256k1 recover loop, and returns packed 20-byte addresses. Callers use
 * the result only to warm memo caches; the synchronous verifier remains the
 * authority, so a missing or failed batch entry costs nothing but the shortcut.
 *
 * Record layout: [32 digest][64 compact signature][1 recovery(0|1)] = 97 bytes.
 * Result layout: [20 address] per record, all-zero when recovery failed.
 */
import { keccak256Bytes } from './fast-keccak';

// Bun-only. The module is imported by shared core, so it must not touch node
// built-ins at load time (the browser bundle resolves them to empty shims).
type BunGlobal = { isMainThread?: boolean };
const bunRuntime = (): BunGlobal | undefined => (globalThis as { Bun?: BunGlobal }).Bun;
type EcdsaWorkerScope = {
  setOnMessage: (listener: (event: MessageEvent<Job>) => void) => void;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
const workerScope = (): EcdsaWorkerScope | undefined => {
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

type NativeSecp256k1 = {
  ecdsaRecover(signature: Uint8Array, recid: number, message: Uint8Array, compressed: boolean): Uint8Array;
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

type Job = { id: number; records: Uint8Array };

const scope = workerScope();
if (scope && process.env['XLN_ECDSA_RECOVER_WORKER'] === '1') {
  const native = loadNative();
  scope.setOnMessage((event: MessageEvent<Job>) => {
    const job = event.data;
    const result = native ? recoverBatchSync(native, job.records) : new Uint8Array(0);
    scope.postMessage({ id: job.id, result }, [result.buffer as ArrayBuffer]);
  });
}

let pool: Worker[] | null | undefined;
let nextJobId = 0;
const pending = new Map<number, (result: Uint8Array) => void>();

const poolSize = (): number => {
  const raw = process.env['XLN_ECDSA_RECOVER_WORKERS'];
  const configured = raw === undefined || raw === '' ? NaN : Number(raw);
  if (Number.isSafeInteger(configured) && configured >= 0) return configured;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
  return Math.max(0, Math.min(8, (cores || 2) - 2));
};

/** A dead worker fails every in-flight job closed: callers fall back to the sync verifier. */
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
      env: { ...process.env, XLN_ECDSA_RECOVER_WORKER: '1' },
    } as WorkerOptions);
    worker.onmessage = event => {
      const { id, result } = event.data as { id: number; result: Uint8Array };
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

export const ecdsaRecoverPoolEnabled = (): boolean => getPool() !== null;

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
  const parts: Promise<{ offset: number; result: Uint8Array }>[] = [];
  for (let start = 0, slot = 0; start < count; start += perWorker, slot += 1) {
    const end = Math.min(count, start + perWorker);
    // Own buffer per job so the transfer list detaches only this slice.
    const slice = records.slice(start * ECDSA_RECOVER_RECORD_BYTES, end * ECDSA_RECOVER_RECORD_BYTES);
    const id = nextJobId += 1;
    const worker = workers[slot % workers.length];
    if (!worker) throw new Error('ECDSA_RECOVER_WORKER_SLOT_MISSING');
    parts.push(new Promise(resolve => {
      pending.set(id, result => resolve({ offset: start, result }));
      worker.postMessage({ id, records: slice } satisfies Job, [slice.buffer as ArrayBuffer]);
    }));
  }
  const out = new Uint8Array(count * ECDSA_RECOVER_RESULT_BYTES);
  for (const { offset, result } of await Promise.all(parts)) {
    if (result.length === 0) return null;
    out.set(result, offset * ECDSA_RECOVER_RESULT_BYTES);
  }
  return out;
};
