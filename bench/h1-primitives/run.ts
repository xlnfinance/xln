#!/usr/bin/env bun

import { performance } from 'node:perf_hooks';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { measurePrimitiveRates, runPaymentWork } from './model';
import { measureLevelDb } from './storage';
import {
  CRYPTO_PROFILES,
  type ComputeMeasurement,
  type CryptoProfile,
  type PaymentWorkRequest,
  type PaymentWorkResult,
  type StorageMeasurement,
} from './types';

const positiveIntegerArgument = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`H1_PRIMITIVE_ARGUMENT_INVALID:${name}:${String(process.argv[index + 1])}`);
  }
  return value;
};

type ProcessWorker = Readonly<{
  child: ChildProcessWithoutNullStreams;
  nextLine: () => Promise<string>;
}>;

const startProcessWorker = async (): Promise<ProcessWorker> => {
  const child = spawn(process.execPath, [new URL('./worker.ts', import.meta.url).pathname], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffered = '';
  const completeLines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    while (buffered.includes('\n')) {
      const newline = buffered.indexOf('\n');
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else completeLines.push(line);
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const nextLine = (): Promise<string> => {
    const ready = completeLines.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      waiters.push(resolve);
      child.once('exit', code => reject(new Error(
        `H1_PRIMITIVE_PROCESS_EXITED:${String(code)}:${stderr.trim()}`,
      )));
    });
  };
  const ready = JSON.parse(await nextLine()) as { type?: string };
  if (ready.type !== 'ready') throw new Error('H1_PRIMITIVE_PROCESS_READY_INVALID');
  return { child, nextLine };
};

const requestWorker = async (
  worker: ProcessWorker,
  request: PaymentWorkRequest,
): Promise<PaymentWorkResult> => {
  worker.child.stdin.write(`${JSON.stringify(request)}\n`);
  const encoded = JSON.parse(await worker.nextLine()) as Omit<PaymentWorkResult, 'output'> & { output: string };
  return { ...encoded, output: Uint8Array.from(Buffer.from(encoded.output, 'base64')) };
};

const partitions = (payments: number, workers: number): Array<Readonly<{ start: number; count: number }>> => {
  const result: Array<Readonly<{ start: number; count: number }>> = [];
  for (let worker = 0; worker < workers; worker += 1) {
    const start = Math.floor(payments * worker / workers);
    const end = Math.floor(payments * (worker + 1) / workers);
    result.push({ start, count: end - start });
  }
  return result;
};

const reduceOutputs = (results: readonly PaymentWorkResult[]): Readonly<{ root: string; elapsedMs: number }> => {
  const startedAt = performance.now();
  let root = new Uint8Array(32);
  const pair = new Uint8Array(64);
  for (const result of [...results].sort((left, right) => left.startPayment - right.startPayment)) {
    for (let offset = 0; offset < result.output.length; offset += 32) {
      pair.set(root, 0);
      pair.set(result.output.subarray(offset, offset + 32), 32);
      root = keccak_256(pair);
    }
  }
  return { root: `0x${Buffer.from(root).toString('hex')}`, elapsedMs: performance.now() - startedAt };
};

const computeSingle = (payments: number, profile: CryptoProfile): ComputeMeasurement => {
  runPaymentWork({ startPayment: 0, payments: Math.min(100, payments), profile });
  const startedAt = performance.now();
  const result = runPaymentWork({ startPayment: 0, payments, profile });
  const reduced = reduceOutputs([result]);
  const wallMs = performance.now() - startedAt;
  return {
    profile: profile.name,
    workers: 1,
    payments,
    wallMs,
    workerCpuMs: result.elapsedMs,
    reduceMs: reduced.elapsedMs,
    tps: payments * 1_000 / wallMs,
    signatures: result.signatures,
    recovers: result.recovers,
    keccaks: result.keccaks + payments,
    binaryPreimageBytes: result.binaryPreimageBytes,
    outputBytes: result.output.byteLength,
    root: reduced.root,
  };
};

const computeParallel = async (
  payments: number,
  workerCount: number,
  profile: CryptoProfile,
): Promise<ComputeMeasurement> => {
  const workers = await Promise.all(Array.from(
    { length: workerCount },
    () => startProcessWorker(),
  ));
  try {
    await Promise.all(workers.map((worker, index) => requestWorker(worker, {
      startPayment: index * 20,
      payments: 20,
      profile,
    })));
    const split = partitions(payments, workerCount);
    const startedAt = performance.now();
    const results = await Promise.all(workers.map((worker, index) => requestWorker(worker, {
      startPayment: split[index]!.start,
      payments: split[index]!.count,
      profile,
    })));
    const reduced = reduceOutputs(results);
    const wallMs = performance.now() - startedAt;
    return {
      profile: profile.name,
      workers: workerCount,
      payments,
      wallMs,
      workerCpuMs: results.reduce((sum, result) => sum + result.elapsedMs, 0),
      reduceMs: reduced.elapsedMs,
      tps: payments * 1_000 / wallMs,
      signatures: results.reduce((sum, result) => sum + result.signatures, 0),
      recovers: results.reduce((sum, result) => sum + result.recovers, 0),
      keccaks: results.reduce((sum, result) => sum + result.keccaks, 0) + payments,
      binaryPreimageBytes: results.reduce((sum, result) => sum + result.binaryPreimageBytes, 0),
      outputBytes: results.reduce((sum, result) => sum + result.output.byteLength, 0),
      root: reduced.root,
    };
  } finally {
    for (const worker of workers) {
      worker.child.stdin.end();
      worker.child.kill('SIGTERM');
    }
  }
};

const composedTps = (
  compute: ComputeMeasurement,
  storage: StorageMeasurement,
): Readonly<{ sequential: number; pipelined: number }> => ({
  sequential: compute.payments * 1_000 / (compute.wallMs + storage.wallMs),
  pipelined: Math.min(compute.tps, storage.tps),
});

const main = async (): Promise<void> => {
  const payments = positiveIntegerArgument('payments', 10_000);
  const parallelWorkers = positiveIntegerArgument('workers', 10);
  const primitiveRates = measurePrimitiveRates();
  const compute: ComputeMeasurement[] = [];
  for (const profile of CRYPTO_PROFILES) {
    compute.push(computeSingle(payments, profile));
    compute.push(await computeParallel(payments, parallelWorkers, profile));
  }
  const storage: StorageMeasurement[] = [];
  for (const batchSize of [1, 10, 100, 750]) {
    storage.push(await measureLevelDb(payments, batchSize, 'leveldb-async'));
    storage.push(await measureLevelDb(payments, batchSize, 'leveldb-fsync'));
  }
  const compositions = compute.flatMap(computeResult => storage.map(storageResult => ({
    profile: computeResult.profile,
    workers: computeResult.workers,
    storage: storageResult.mode,
    batchSize: storageResult.batchSize,
    ...composedTps(computeResult, storageResult),
  })));
  console.log(JSON.stringify({
    schema: 'xln-h1-primitive-benchmark-v2',
    assumptions: {
      economicPayment: 'two locks + two resolves across independent Account machines',
      accountMutationsPerPayment: 4,
      cryptoProfiles: 'synthetic operation-count bounds, not xln protocol stages; Account-frame batching can amortize signatures across payments',
      cachedMerkleDepth: 10,
      storageValueBytesPerPayment: 5_120,
      storageCommit: 'one LevelDB batch plus one head update; sync=true is the crash-durable fsync boundary',
      workerModel: 'independent Account maps, 32-byte result per payment, deterministic ordered root reduction',
    },
    hypotheses: [
      'the H1-side two-sign+recover profile fits above 1000 TPS on one core',
      'four sign+recover pairs fit above 1000 TPS on one core',
      'eight sign+recover pairs expose the one-core crypto boundary without naming a protocol cause',
      'per-payment fsync is the disk lower bound and batching amortizes it',
      'ten Account workers expose whether crypto/hash work scales before the single reducer',
      'one LevelDB writer remains sufficient at 1000 TPS when commits contain many payments',
    ],
    payments,
    primitiveRates,
    compute,
    storage,
    compositions,
  }, null, 2));
};

await main();
