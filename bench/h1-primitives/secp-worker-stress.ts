import { keccak_256 } from '@noble/hashes/sha3.js';

type WorkerResult = Readonly<{
  worker: number;
  iterations: number;
  checksum: number;
}>;

const workerCount = Number(Bun.env.XLN_SECP_WORKERS ?? 10);
const iterations = Number(Bun.env.XLN_SECP_ITERATIONS ?? 10_000);
const timeoutMs = Number(Bun.env.XLN_SECP_TIMEOUT_MS ?? 120_000);

const requirePositiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name}_INVALID:${value}`);
  return value;
};

const runWorker = async (): Promise<void> => {
  const worker = requirePositiveInteger(Number(Bun.env.XLN_SECP_WORKER_INDEX), 'XLN_SECP_WORKER_INDEX');
  const count = requirePositiveInteger(iterations, 'XLN_SECP_ITERATIONS');
  const secp256k1 = (await import('secp256k1')).default;
  const privateKey = new Uint8Array(32);
  privateKey[31] = worker;
  const expectedPublicKey = secp256k1.publicKeyCreate(privateKey, false);
  const input = new Uint8Array(64);
  let checksum = 0;
  for (let index = 0; index < count; index += 1) {
    new DataView(input.buffer).setUint32(0, index, false);
    new DataView(input.buffer).setUint32(4, worker, false);
    const digest = keccak_256(input);
    const signed = secp256k1.ecdsaSign(digest, privateKey);
    const recovered = secp256k1.ecdsaRecover(signed.signature, signed.recid, digest, false);
    if (!recovered.every((byte, offset) => byte === expectedPublicKey[offset])) {
      throw new Error(`SECP_WORKER_RECOVERY_MISMATCH:${worker}:${index}`);
    }
    checksum ^= recovered[index % recovered.length]!;
    if (index % 1_000 === 0) Bun.gc(true);
  }
  postMessage({ worker, iterations: count, checksum } satisfies WorkerResult);
};

const runMain = async (): Promise<void> => {
  const count = requirePositiveInteger(workerCount, 'XLN_SECP_WORKERS');
  const startedAt = performance.now();
  const workers = Array.from({ length: count }, (_, index) => {
    const worker = new Worker(new URL(import.meta.url).href, {
      env: { ...Bun.env, XLN_SECP_WORKER_INDEX: String(index + 1) },
    });
    return new Promise<WorkerResult>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data as WorkerResult);
      worker.onerror = event => reject(new Error(`SECP_WORKER_ERROR:${index + 1}:${event.message}`));
    });
  });
  const timer = setTimeout(() => {
    throw new Error(`SECP_WORKER_TIMEOUT:${timeoutMs}`);
  }, timeoutMs);
  const results = await Promise.all(workers);
  clearTimeout(timer);
  console.log(JSON.stringify({
    schema: 'xln-secp256k1-worker-stress-v1',
    bun: Bun.version,
    workers: count,
    iterationsPerWorker: iterations,
    operations: count * iterations * 2,
    elapsedMs: performance.now() - startedAt,
    checksums: results.map(result => result.checksum),
  }));
};

if (Bun.isMainThread) {
  await runMain();
} else {
  await runWorker();
}
