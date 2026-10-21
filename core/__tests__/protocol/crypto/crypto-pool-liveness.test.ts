import { expect, test } from 'bun:test';
import { safeStringify } from '../../../protocol/serialization';

const moduleUrl = new URL('../../../protocol/crypto/crypto-pool.ts', import.meta.url).href;
const runChild = (body: string, workers = '1') =>
  Bun.spawnSync({
    cmd: [
      process.execPath,
      '--eval',
      `
    import { configureCryptoPoolEntry, cryptoPoolEnabled, cryptoSignPoolEnabled, signDigestsBatchOnPool, recoverAddressesBatch, decryptOnionLayersBatch } from ${safeStringify(moduleUrl)};
    import { computeAddress, hexlify, recoverAddress } from 'ethers';
    configureCryptoPoolEntry(new URL(${safeStringify(moduleUrl)}));
    async function run() { ${body} }
    // Match a daemon entry before its HTTP server owns a live event-loop handle.
    // Awaiting run at module scope would conceal premature worker unref.
    run().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    cwd: process.cwd(),
    env: { ...process.env, XLN_CRYPTO_SIGN_WORKERS: workers, XLN_CRYPTO_POOL_WORKERS: workers },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5_000,
  });

test('crypto lanes allocate real workers only for nonempty demand and retain growing in-flight lanes', () => {
  const child = runChild(
    `
    let allocations = 0;
    // Count construction while delegating every job to the real Bun Worker.
    globalThis.Worker = new Proxy(Worker, {
      construct(target, args) { allocations++; return Reflect.construct(target, args); },
    });
    const check = (condition, code) => { if (!condition) throw Error(code); };
    check(cryptoPoolEnabled() && cryptoSignPoolEnabled(), 'CRYPTO_LANES_UNAVAILABLE');
    check(allocations === 0, 'AVAILABILITY_ALLOCATED_IDLE_WORKERS');
    const key = new Uint8Array(32).fill(1);
    const empty = new Uint8Array(0);
    check((await signDigestsBatchOnPool(key, empty)).length === 0, 'EMPTY_SIGN');
    check((await recoverAddressesBatch(empty)).length === 0, 'EMPTY_RECOVER');
    check((await decryptOnionLayersBatch([])).length === 0, 'EMPTY_ONION');
    check(allocations === 0, 'EMPTY_BATCH_ALLOCATED_IDLE_WORKERS');
    const native = require('secp256k1/bindings');
    const digest = new Uint8Array(32).fill(2);
    const first = signDigestsBatchOnPool(key, digest);
    check(allocations === 1, 'SINGLE_SIGN_ALLOCATED_IDLE_WORKERS');
    const many = new Uint8Array(32 * 17);
    for (let index = 0; index < 17; index++) many.fill(index + 3, index * 32, (index + 1) * 32);
    const batch = signDigestsBatchOnPool(key, many);
    check(allocations === 4, 'SIGN_LANE_DID_NOT_GROW_TO_DEMAND');
    const results = await Promise.all([first, batch]);
    for (const [input, result] of [[digest, results[0]], [many, results[1]]]) {
      check(result && result.length === input.length / 32 * 65, 'SIGN_JOB_INCOMPLETE');
      for (let index = 0; index < input.length / 32; index++) {
        const expected = native.ecdsaSign(input.subarray(index * 32, (index + 1) * 32), key);
        check(hexlify(result.subarray(index * 65, index * 65 + 64)) === hexlify(expected.signature), 'SIGNATURE_BYTES_OR_ORDER_CHANGED');
        check(result[index * 65 + 64] === expected.recid, 'SIGNATURE_RECOVERY_CHANGED');
      }
    }
    const record = new Uint8Array(97); record.set(digest); record.set(results[0], 32);
    const recovered = recoverAddressesBatch(record);
    check(allocations === 5, 'SINGLE_RECOVERY_ALLOCATED_IDLE_WORKERS');
    check(hexlify(await recovered) === computeAddress(hexlify(key)).toLowerCase(), 'RECOVERED_SIGNER_MISMATCH');
    console.log('CRYPTO_DEMAND_COMPLETE signatures=18 recovered=1 workers=5');
  `,
    '4',
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString()).toContain('CRYPTO_DEMAND_COMPLETE signatures=18 recovered=1 workers=5');
  expect(child.stderr.toString()).toBe('');
});

test('crypto jobs keep startup alive until every signature and recovered address completes, then release idle workers', () => {
  const child = runChild(`
    const key = new Uint8Array(32).fill(1);
    const digest = new Uint8Array(32).fill(2);
    const many = new Uint8Array(32 * 16).fill(3);
    const expected = computeAddress(hexlify(key)).toLowerCase();
    const [single, batch] = await Promise.all([
      signDigestsBatchOnPool(key, digest), signDigestsBatchOnPool(key, many),
    ]);
    if (!single || single.length !== 65 || !batch || batch.length !== 16 * 65) throw Error('SIGN_JOB_INCOMPLETE');
    if (recoverAddress(hexlify(digest), hexlify(single)).toLowerCase() !== expected) throw Error('SIGNER_MISMATCH');
    const records = new Uint8Array(16 * 97);
    for (let index = 0; index < 16; index++) {
      records.set(many.subarray(index * 32, (index + 1) * 32), index * 97);
      records.set(batch.subarray(index * 65, (index + 1) * 65), index * 97 + 32);
    }
    const addresses = await recoverAddressesBatch(records);
    if (!addresses || addresses.length !== 16 * 20) throw Error('RECOVER_JOB_INCOMPLETE');
    for (let index = 0; index < 16; index++) {
      if (hexlify(addresses.subarray(index * 20, (index + 1) * 20)) !== expected) throw Error('RECOVERED_SIGNER_MISMATCH');
    }
    console.log('CRYPTO_JOBS_COMPLETE signatures=17 recovered=16');
  `);
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString()).toContain('CRYPTO_JOBS_COMPLETE signatures=17 recovered=16');
  expect(child.stderr.toString()).toBe('');
});

test('a failed crypto worker settles pending jobs and releases its process references', () => {
  const child = runChild(`
    const digest = new Uint8Array(32).fill(2);
    const results = await Promise.all([
      signDigestsBatchOnPool(new Uint8Array(32), digest),
      signDigestsBatchOnPool(new Uint8Array(32), digest),
    ]);
    if (results.some(result => result !== null)) throw Error('FAILED_WORKER_RESULT_INVALID');
    console.log('CRYPTO_FAILED_JOBS_SETTLED count=2');
  `);
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString()).toContain('CRYPTO_FAILED_JOBS_SETTLED count=2');
});

test('native secp256k1 references belong to each worker VM across repeated startup and teardown', () => {
  const child = runChild(`
    const modulePath = require.resolve('secp256k1/bindings.js');
    const exercise = () => {
      const native = require(modulePath);
      const key = new Uint8Array(32); key[31] = 1;
      const digest = new Uint8Array(32); digest[0] = 7;
      const signed = native.ecdsaSign(digest, key);
      const publicKey = native.publicKeyCreate(key);
      if (!native.ecdsaVerify(signed.signature, digest, publicKey)) throw Error('NATIVE_SIGNATURE_INVALID');
      const recovered = native.ecdsaRecover(signed.signature, signed.recid, digest);
      if (hexlify(recovered) !== hexlify(publicKey)) throw Error('NATIVE_SIGNER_INVALID');
      return hexlify(signed.signature);
    };
    const expected = exercise();
    const source = 'const modulePath=' + JSON.stringify(modulePath)
      + '; const hexlify=' + String(bytes => Buffer.from(bytes).toString('hex'))
      + '; (' + exercise.toString() + ')(); self.postMessage("ready");';
    const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    try {
      for (let wave = 0; wave < 8; wave++) {
        const workers = [];
        const closed = [];
        await Promise.all(Array.from({ length: 2 }, () => new Promise((resolve, reject) => {
          const worker = new Worker(url); workers.push(worker);
          // A worker can finish before its sibling reports ready. Observe its
          // close immediately, not after Promise.all has lost that event.
          closed.push(new Promise(resolve => worker.addEventListener('close', resolve, { once: true })));
          worker.onmessage = resolve; worker.onerror = reject;
        })));
        if (exercise() !== expected) throw Error('NATIVE_SIGNATURE_CHANGED');
        for (const worker of workers) worker.terminate();
        await Promise.all(closed);
        if (exercise() !== expected) throw Error('NATIVE_SIGNATURE_CHANGED_AFTER_CLOSE');
      }
    } finally { URL.revokeObjectURL(url); }
    console.log('NATIVE_SECP_WORKER_LIFECYCLE_COMPLETE waves=8 workers=16');
  `);
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString()).toContain('NATIVE_SECP_WORKER_LIFECYCLE_COMPLETE waves=8 workers=16');
  expect(child.stderr.toString()).toBe('');
});
