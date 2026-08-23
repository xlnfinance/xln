/**
 * keccak256 backend selection.
 *
 * Every consensus identity, frame hash, hanko digest and storage key is a
 * keccak256. The pure-JS permutation (noble, also what ethers wraps) is the
 * single largest CPU consumer on a busy hub; the WASM permutation from
 * `hash-wasm` computes the identical digest 6–8x faster. The WASM module is
 * instantiated asynchronously, so hashing starts on the JS backend and swaps
 * to WASM once ready — the digest bytes are the same either way, so the swap
 * point is not observable to consensus.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { keccak256 } from 'ethers';

type WasmHasher = {
  init(): unknown;
  update(data: Uint8Array): unknown;
  digest(outputType: 'binary'): Uint8Array;
};

let wasmHasher: WasmHasher | null = null;

/** Raw keccak256 digest bytes of `data`, on the fastest available backend. */
export const keccak256Bytes = (data: Uint8Array): Uint8Array => {
  const hasher = wasmHasher;
  if (hasher) {
    hasher.init();
    hasher.update(data);
    // hash-wasm copies the digest out of WASM memory; the caller owns it.
    return hasher.digest('binary');
  }
  return keccak_256(data);
};

let installation: Promise<boolean> | null = null;

/**
 * Instantiate the WASM backend and route `ethers.keccak256` through it.
 * Resolves `true` when WASM is active, `false` when the JS backend stays
 * (unsupported host, or ethers' registry already locked). Idempotent.
 */
export const installFastKeccak = (): Promise<boolean> => {
  if (installation) return installation;
  installation = (async () => {
    try {
      const { createKeccak } = await import('hash-wasm');
      const hasher = await createKeccak(256);
      // Verify the backend against the JS reference before trusting it.
      const probe = new TextEncoder().encode('xln-fast-keccak-probe');
      hasher.init();
      hasher.update(probe);
      const wasmDigest = hasher.digest('binary');
      const jsDigest = keccak_256(probe);
      if (wasmDigest.length !== jsDigest.length || wasmDigest.some((byte, index) => byte !== jsDigest[index])) {
        return false;
      }
      wasmHasher = hasher;
    } catch {
      return false;
    }
    try {
      keccak256.register(keccak256Bytes);
    } catch {
      // Registry locked: ethers callers keep the JS backend, direct callers use WASM.
    }
    return true;
  })();
  return installation;
};

void installFastKeccak();
