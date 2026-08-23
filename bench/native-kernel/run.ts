import { dlopen, FFIType, ptr, suffix } from 'bun:ffi';
import secp256k1 from 'secp256k1';
import { keccak256Bytes } from '../../core/protocol/crypto/fast/fast-keccak';

const here = import.meta.dir;
const libraryPath = `${here}/target/release/libxln_native_kernel_bench.${suffix}`;
const serverPath = `${here}/target/release/xln-native-kernel-server`;
const napi = require(`${here}/napi/target/release/xln_native_kernel_napi.node`) as {
  recoverBatch(records: Uint8Array, threads: number): Uint8Array;
  sha256Batch(records: Uint8Array, stride: number, threads: number): Uint8Array;
};
const count = Number(process.env['XLN_NATIVE_BENCH_COUNT'] ?? 16_384);
const rounds = Number(process.env['XLN_NATIVE_BENCH_ROUNDS'] ?? 5);
const threadCounts = [1, 4, 8, 16, 32];

const library = dlopen(libraryPath, {
  xln_sha256_batch: { args: [FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  xln_recover_batch: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  xln_copy_batch: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
});

const privateKey = new Uint8Array(32); privateKey[31] = 7;
const records = new Uint8Array(count * 97);
for (let index = 0; index < count; index += 1) {
  const digest = new Uint8Array(32);
  new DataView(digest.buffer).setUint32(28, index + 1, false);
  const signature = secp256k1.ecdsaSign(digest, privateKey);
  const offset = index * 97;
  records.set(digest, offset);
  records.set(signature.signature, offset + 32);
  records[offset + 96] = signature.recid;
}
const leafStride = 512;
const leaves = new Uint8Array(count * leafStride);
for (let index = 0; index < leaves.length; index += 1) leaves[index] = (index * 17 + 11) & 0xff;

const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const measure = (work: () => void): number => {
  work();
  const values: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now(); work(); values.push(performance.now() - start);
  }
  return median(values);
};
const result = (name: string, ms: number, units = count) => ({ name, ms: Number(ms.toFixed(3)), opsPerSecond: Math.round(units * 1000 / ms) });

const copyOut = new Uint8Array(records.length);
console.log(JSON.stringify(result('ffi.copy.boundary+memcpy', measure(() => {
  if (library.symbols.xln_copy_batch(ptr(records), records.length, ptr(copyOut)) !== 0) throw new Error('copy');
}), records.length), null, 2));

for (const threads of threadCounts) {
  const hashOut = new Uint8Array(count * 32);
  const ms = measure(() => {
    if (library.symbols.xln_sha256_batch(ptr(leaves), count, leafStride, ptr(hashOut), threads) !== 0) throw new Error('hash');
  });
  console.log(JSON.stringify(result(`rust.ffi.sha256-512.t${threads}`, ms), null, 2));
}

for (const threads of threadCounts) {
  const ms = measure(() => { if (napi.sha256Batch(leaves, leafStride, threads).length !== count * 32) throw new Error('napi hash'); });
  console.log(JSON.stringify(result(`rust.napi.sha256-512.t${threads}`, ms), null, 2));
}

const expectedAddress = keccak256Bytes(secp256k1.publicKeyCreate(privateKey, false).subarray(1)).subarray(12);
for (const threads of threadCounts) {
  const recoverOut = new Uint8Array(count * 20);
  const ms = measure(() => {
    if (library.symbols.xln_recover_batch(ptr(records), count, ptr(recoverOut), threads) !== 0) throw new Error('recover');
  });
  for (const sample of [0, count - 1]) {
    if (!recoverOut.subarray(sample * 20, sample * 20 + 20).every((byte, index) => byte === expectedAddress[index])) {
      throw new Error(`rust recover mismatch at ${sample}`);
    }
  }
  console.log(JSON.stringify(result(`rust.ffi.recover+keccak.t${threads}`, ms), null, 2));
}

for (const threads of threadCounts) {
  const ms = measure(() => { if (napi.recoverBatch(records, threads).length !== count * 20) throw new Error('napi recover'); });
  console.log(JSON.stringify(result(`rust.napi.recover+keccak.t${threads}`, ms), null, 2));
}

const napiOut = new Uint8Array(count * 20);
const napiMs = measure(() => {
  for (let index = 0; index < count; index += 1) {
    const offset = index * 97;
    const publicKey = secp256k1.ecdsaRecover(records.subarray(offset + 32, offset + 96), records[offset + 96]!, records.subarray(offset, offset + 32), false);
    napiOut.set(keccak256Bytes(publicKey.subarray(1)).subarray(12), index * 20);
  }
});
console.log(JSON.stringify(result('node-addon.per-record.recover+keccak', napiMs), null, 2));

const runWorkers = async (workersCount: number): Promise<number> => {
  const workers = Array.from({ length: workersCount }, () => new Worker(`${here}/worker.ts`));
  const perWorker = Math.ceil(count / workersCount);
  const oneRound = async () => {
    await Promise.all(workers.map((worker, workerIndex) => new Promise<void>((resolve, reject) => {
      const start = workerIndex * perWorker * 97;
      const end = Math.min(records.length, start + perWorker * 97);
      if (start >= end) return resolve();
      const payload = records.slice(start, end);
      worker.onmessage = () => resolve(); worker.onerror = reject;
      worker.postMessage({ id: workerIndex, records: payload }, [payload.buffer]);
    })));
  };
  await oneRound();
  const values: number[] = [];
  for (let round = 0; round < rounds; round += 1) { const start = performance.now(); await oneRound(); values.push(performance.now() - start); }
  for (const worker of workers) worker.terminate();
  return median(values);
};

if (process.env['XLN_NATIVE_BENCH_WORKERS'] !== '0') {
  for (const workers of threadCounts.slice(0, 4)) console.log(JSON.stringify(result(`bun.worker.node-addon.recover+keccak.w${workers}`, await runWorkers(workers)), null, 2));
}

const readExact = async (reader: ReadableStreamDefaultReader<Uint8Array>, length: number): Promise<Uint8Array> => {
  const output = new Uint8Array(length); let offset = 0;
  while (offset < length) { const { value, done } = await reader.read(); if (done || !value) throw new Error('eof'); output.set(value.subarray(0, Math.min(value.length, length - offset)), offset); offset += value.length; }
  return output;
};

const processRound = async (op: number, input: Uint8Array, stride: number, threads: number): Promise<number> => {
  const child = Bun.spawn([serverPath], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
  const header = new Uint8Array(16); const view = new DataView(header.buffer);
  view.setUint32(0, op, true); view.setUint32(4, count, true); view.setUint32(8, stride, true); view.setUint32(12, threads, true);
  const start = performance.now();
  child.stdin.write(header); child.stdin.write(input); child.stdin.end();
  const responseLength = op === 1 ? count * 32 : count * 20;
  await readExact(child.stdout.getReader(), responseLength + 8); await child.exited;
  return performance.now() - start;
};
for (const threads of [1, 8, 16]) {
  const values: number[] = [];
  for (let round = 0; round < 3; round += 1) values.push(await processRound(2, records, 97, threads));
  console.log(JSON.stringify(result(`process.pipe+spawn.recover+keccak.t${threads}`, median(values)), null, 2));
}

library.close();
