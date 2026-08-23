/**
 * SHA-256 / HMAC-SHA256 backend selection (same scheme as fast-keccak):
 * start on the JS implementation, switch to the WASM one once instantiated.
 * Digests are identical on both backends.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

type WasmHasher = {
  init(): unknown;
  update(data: Uint8Array): unknown;
  digest(outputType: 'binary'): Uint8Array;
};

let wasmSha256: WasmHasher | null = null;
const BLOCK = 64;

const wasmDigest = (hasher: WasmHasher, ...parts: Uint8Array[]): Uint8Array => {
  hasher.init();
  for (const part of parts) hasher.update(part);
  return hasher.digest('binary');
};

type NativeHmac = { update(data: Uint8Array): NativeHmac; digest(): Uint8Array };
type NativeHmacConstructor = new (algorithm: string, key: Uint8Array) => NativeHmac;
// Bun's CryptoHasher with a key is HMAC (BoringSSL): ~10x faster than the WASM
// path at every size. Browsers fall through to WASM, then noble.
const nativeHmac = ((): NativeHmacConstructor | undefined => {
  const bunRuntime: unknown = Reflect.get(globalThis, 'Bun');
  const constructor: unknown = bunRuntime && typeof bunRuntime === 'object' ? Reflect.get(bunRuntime, 'CryptoHasher') : undefined;
  return typeof constructor === 'function' ? constructor as NativeHmacConstructor : undefined;
})();

/** HMAC-SHA256(key, data) as raw bytes. */
export const hmacSha256 = (key: Uint8Array, data: Uint8Array): Uint8Array => {
  if (nativeHmac) return new Uint8Array(new nativeHmac('sha256', key).update(data).digest());
  const hasher = wasmSha256;
  if (!hasher) return hmac(sha256, key, data);
  const blockKey = new Uint8Array(BLOCK);
  blockKey.set(key.length > BLOCK ? wasmDigest(hasher, key) : key);
  const inner = new Uint8Array(BLOCK);
  const outer = new Uint8Array(BLOCK);
  for (let index = 0; index < BLOCK; index += 1) {
    inner[index] = blockKey[index]! ^ 0x36;
    outer[index] = blockKey[index]! ^ 0x5c;
  }
  return wasmDigest(hasher, outer, wasmDigest(hasher, inner, data));
};

let installation: Promise<boolean> | null = null;

const installFastSha256 = (): Promise<boolean> => {
  if (installation) return installation;
  installation = (async () => {
    try {
      const { createSHA256 } = await import('hash-wasm');
      const hasher = await createSHA256();
      const key = new TextEncoder().encode('xln-fast-sha256-probe-key');
      const data = new TextEncoder().encode('xln-fast-sha256-probe');
      const reference = hmac(sha256, key, data);
      if (nativeHmac) {
        const native = hmacSha256(key, data);
        if (native.length !== reference.length || native.some((byte, index) => byte !== reference[index])) {
          throw new Error('FAST_SHA256_NATIVE_HMAC_MISMATCH');
        }
        return true;
      }
      wasmSha256 = hasher;
      const candidate = hmacSha256(key, data);
      if (candidate.length !== reference.length || candidate.some((byte, index) => byte !== reference[index])) {
        wasmSha256 = null;
        return false;
      }
      return true;
    } catch {
      wasmSha256 = null;
      return false;
    }
  })();
  return installation;
};

void installFastSha256();
