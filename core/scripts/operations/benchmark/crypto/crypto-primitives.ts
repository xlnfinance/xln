/**
 * Diagnostic-only production-primitive benchmark. This is neither a Runtime
 * workload nor economic completion evidence and deliberately emits no TPS.
 * Run through `bun run bench:crypto:ts` so the machine-wide stand lock is held.
 */
import { sha256 } from '@noble/hashes/sha2.js';

import { recoverAddressFromDigestSignature, signDigestBytesWithPrivateKey } from '../../../../account/crypto';
import {
  configureCryptoPoolEntry,
  ECDSA_RECOVER_RECORD_BYTES,
  recoverAddressesBatch,
  signDigestsBatchOnPool,
} from '../../../../protocol/crypto/crypto-pool';
import { installFastKeccak, keccak256Bytes } from '../../../../protocol/crypto/fast/fast-keccak';
import { hmacSha256 } from '../../../../protocol/crypto/fast/fast-sha256';
import { x25519PublicKey, x25519SharedSecret } from '../../../../protocol/crypto/fast/fast-x25519';
import { safeStringify } from '../../../../protocol/serialization';

const numericArgument = (name: string, defaultValue: number): number => {
  const prefix = `--${name}=`;
  const raw = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
  const value = raw === undefined ? defaultValue : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`CRYPTO_BENCH_${name.toUpperCase()}_INVALID`);
  return value;
};

const count = numericArgument('count', 1_000);
const workers = numericArgument('workers', 8);
process.env['XLN_CRYPTO_POOL_WORKERS'] = String(workers);
process.env['XLN_CRYPTO_SIGN_WORKERS'] = String(workers);
configureCryptoPoolEntry(new URL('../../../../protocol/crypto/crypto-pool.ts', import.meta.url));

const payload = new Uint8Array(64).fill(0x2b);
const privateKey = new Uint8Array(32).fill(7);
const digest = new Uint8Array(32).fill(11);
const x25519Private = new Uint8Array(32).fill(13);
const x25519PeerPublic = x25519PublicKey(new Uint8Array(32).fill(17));
const signature = signDigestBytesWithPrivateKey(privateKey, digest);

const measureSync = (
  operation: () => Uint8Array | string,
): Readonly<{ ms: number; checksum: number }> => {
  let checksum = 0;
  const started = Bun.nanoseconds();
  for (let index = 0; index < count; index += 1) {
    const value = operation();
    checksum ^= typeof value === 'string' ? value.charCodeAt(0) : (value[0] ?? 0);
  }
  return Object.freeze({ ms: (Bun.nanoseconds() - started) / 1e6, checksum });
};

const buildDigests = (size: number): Uint8Array => {
  const rows = new Uint8Array(size * 32);
  for (let index = 0; index < size; index += 1) rows.set(digest, index * 32);
  return rows;
};

const buildRecoveryRecords = (size: number): Uint8Array => {
  const rows = new Uint8Array(size * ECDSA_RECOVER_RECORD_BYTES);
  for (let index = 0; index < size; index += 1) {
    const offset = index * ECDSA_RECOVER_RECORD_BYTES;
    rows.set(digest, offset);
    rows.set(signature.signature, offset + 32);
    rows[offset + 96] = signature.recovery;
  }
  return rows;
};

await installFastKeccak();
for (let index = 0; index < 1_000; index += 1) {
  keccak256Bytes(payload);
  sha256(payload);
  hmacSha256(privateKey, payload);
}

const keccak = measureSync(() => keccak256Bytes(payload));
const sha = measureSync(() => sha256(payload));
const hmac = measureSync(() => hmacSha256(privateKey, payload));
const x25519 = measureSync(() => x25519SharedSecret(x25519Private, x25519PeerPublic));
const sequentialSign = measureSync(() => signDigestBytesWithPrivateKey(privateKey, digest).signature);
const sequentialRecover = measureSync(() => {
  const address = recoverAddressFromDigestSignature(digest, signature.signature, signature.recovery);
  if (!address) throw new Error('CRYPTO_BENCH_RECOVERY_FAILED');
  return address;
});

const warmup = Math.min(count, 1_000);
await signDigestsBatchOnPool(privateKey, buildDigests(warmup));
await recoverAddressesBatch(buildRecoveryRecords(warmup));
let started = Bun.nanoseconds();
const batchSignatures = await signDigestsBatchOnPool(privateKey, buildDigests(count));
const batchSignMs = (Bun.nanoseconds() - started) / 1e6;
started = Bun.nanoseconds();
const batchAddresses = await recoverAddressesBatch(buildRecoveryRecords(count));
const batchRecoverMs = (Bun.nanoseconds() - started) / 1e6;
if (!batchSignatures || !batchAddresses) throw new Error('CRYPTO_BENCH_POOL_UNAVAILABLE');

console.log(
  safeStringify({
    schema: 'xln-crypto-primitives-diagnostic-v1',
    authority: 'DIAGNOSTIC_ONLY_NOT_TPS',
    engine: 'ts-bun-production-primitives',
    count,
    workers,
    inputBytes: payload.length,
    wallMs: {
      keccak256: keccak.ms,
      sha256: sha.ms,
      hmacSha256: hmac.ms,
      x25519: x25519.ms,
      ecdsaSignSequential: sequentialSign.ms,
      ecdsaRecoverAddressSequential: sequentialRecover.ms,
      ecdsaSignBatch: batchSignMs,
      ecdsaRecoverAddressBatch: batchRecoverMs,
    },
    rssBytes: process.memoryUsage.rss(),
    checksum:
      keccak.checksum ^
      sha.checksum ^
      hmac.checksum ^
      x25519.checksum ^
      sequentialSign.checksum ^
      sequentialRecover.checksum ^
      (batchSignatures[0] ?? 0) ^
      (batchAddresses[0] ?? 0),
  }),
);
