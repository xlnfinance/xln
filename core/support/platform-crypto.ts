import { sha256 } from '@noble/hashes/sha2.js';
import * as buffer from 'buffer';

type RuntimeGlobal = typeof globalThis & { Buffer?: typeof buffer.Buffer };

if (typeof global === 'undefined') globalThis.global = globalThis;

declare global {
  interface Window {
    Buffer: typeof Buffer;
  }

  // eslint-disable-next-line no-var
  var global: typeof globalThis;

  interface Uint8Array {
    toString(encoding?: string): string;
  }
}

export const isBrowser = typeof window !== 'undefined';

class XlnSha256Hash {
  private readonly hash = sha256.create();

  update(data: string | Uint8Array): XlnSha256Hash {
    this.hash.update(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    return this;
  }

  digest(): Buffer;
  digest(encoding: 'hex'): string;
  digest(encoding?: 'hex'): Buffer | string {
    const digest = buffer.Buffer.from(this.hash.digest());
    return encoding === 'hex' ? digest.toString('hex') : digest;
  }
}

/** Synchronous SHA-256 with identical bytes in Bun and browser runtimes. */
export const createHash = (algorithm: string): XlnSha256Hash => {
  const normalized = String(algorithm || '').trim().toLowerCase();
  if (normalized !== 'sha256' && normalized !== 'sha-256') {
    throw new Error(`HASH_ALGORITHM_UNSUPPORTED:${algorithm}`);
  }
  return new XlnSha256Hash();
};

/** Browser-compatible asynchronous SHA-256 for non-consensus tooling. */
export const cryptoHash = async (content: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const hex = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  return `0x${hex}`;
};

const getBuffer = (): typeof buffer.Buffer => {
  const globalBuffer = (globalThis as RuntimeGlobal).Buffer;
  return globalBuffer && typeof globalBuffer.isBuffer === 'function'
    ? globalBuffer
    : buffer.Buffer;
};

export const Buffer = getBuffer();

if (isBrowser) {
  Uint8Array.prototype.toString = function (_encoding: string = 'utf8') {
    return new TextDecoder().decode(this);
  };
  if ((globalThis as RuntimeGlobal).Buffer !== Buffer) {
    (globalThis as RuntimeGlobal).Buffer = Buffer;
  }
  window.Buffer = Buffer;
}
