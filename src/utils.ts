/**
 * XLN Utility Functions
 * Platform detection, crypto polyfills, logging, and helper functions
 */

// Global polyfills for browser compatibility
if (typeof global === 'undefined') {
  (globalThis as any).global = globalThis;
}



// Environment detection and compatibility layer
export const isBrowser = typeof window !== 'undefined';

// Simplified crypto compatibility
export const createHash = isBrowser ? 
  (algorithm: string) => ({
    update: (data: string) => ({
      digest: (encoding?: string) => {
        // Simple deterministic hash for browser demo
        let hash = 0;
        for (let i = 0; i < data.length; i++) {
          const char = data.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash; // Convert to 32bit integer
        }
        const hashStr = Math.abs(hash).toString(16).padStart(8, '0');
        return encoding === 'hex' ? hashStr : Buffer.from(hashStr);
      }
    })
  }) :
  require('crypto').createHash;

export const randomBytes = isBrowser ?
  (size: number): Uint8Array => {
    const array = new Uint8Array(size);
    crypto.getRandomValues(array);
    return array;
  } :
  require('crypto').randomBytes;

// Simplified Buffer polyfill for browser
const getBuffer = () => {
  if (isBrowser) {
    return {
      from: (data: any, encoding: string = 'utf8') => {
        if (typeof data === 'string') {
          return new TextEncoder().encode(data);
        }
        return new Uint8Array(data);
      }
    };
  }
  return require('buffer').Buffer;
};

export const Buffer = getBuffer();

// Browser polyfill for Uint8Array.toString()
if (isBrowser) {
  (Uint8Array.prototype as any).toString = function(encoding: string = 'utf8') {
    return new TextDecoder().decode(this);
  };
  (window as any).Buffer = Buffer;
}

// Debug compatibility
const createDebug = (namespace: string) => {
  const shouldLog = namespace.includes('state') || namespace.includes('tx') || 
                   namespace.includes('block') || namespace.includes('error') || 
                   namespace.includes('diff') || namespace.includes('info');
  return shouldLog ? console.log.bind(console, `[${namespace}]`) : () => {};
};

const debug = isBrowser ? createDebug : require('debug');

// Configure debug logging with functional approach
export const log = {
  state: debug('state:🔵'),
  tx: debug('tx:🟡'),
  block: debug('block:🟢'),
  error: debug('error:🔴'),
  diff: debug('diff:🟣'),
  info: debug('info:ℹ️')
};

// Hash utility function
export const hash = (data: Buffer | string): Buffer => 
  createHash('sha256').update(data.toString()).digest();

// Global debug flag
export let DEBUG = true;

// Function to clear the database and reset in-memory history
export const clearDatabase = async (db: any) => {
  console.log('Clearing database and resetting history...');
  await db.clear();
  console.log('Database cleared.');
  // After calling this, you might need to restart the process or reload the page
  // to re-initialize the environment from a clean state.
}; 