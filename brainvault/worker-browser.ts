/**
 * BrainVault Browser Worker
 *
 * This file is built separately for browser use:
 *   bun build brainvault/worker-browser.ts --outfile frontend/static/brainvault-worker.js
 *
 * Uses hash-wasm (WebAssembly) for browser compatibility.
 */

import { argon2id } from 'hash-wasm';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { BRAINVAULT_V1 } from './core.ts';

/**
 * Create salt for a specific shard
 * Must match core.ts createShardSalt() exactly
 */
function createShardSalt(name: string, shardIndex: number, shardCount: number, algId: string = BRAINVAULT_V1.ALG_ID): Uint8Array {
  const normalized = name.normalize('NFKD');
  const nameBytes = new TextEncoder().encode(normalized);
  const algIdBytes = new TextEncoder().encode(algId);
  const countBytes = new Uint8Array(4);
  new DataView(countBytes.buffer).setUint32(0, shardCount, false);
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, shardIndex, false);

  const combined = new Uint8Array(nameBytes.length + algIdBytes.length + 4 + 4);
  combined.set(nameBytes, 0);
  combined.set(algIdBytes, nameBytes.length);
  combined.set(countBytes, nameBytes.length + algIdBytes.length);
  combined.set(indexBytes, nameBytes.length + algIdBytes.length + 4);

  return blake3(combined);
}

/**
 * Derive a single shard
 */
async function deriveShard(passphrase: string, shardSalt: Uint8Array, memorySizeKb: number = BRAINVAULT_V1.SHARD_MEMORY_KB): Promise<Uint8Array> {
  const normalized = passphrase.normalize('NFKD');
  const result = await argon2id({
    password: normalized,
    salt: shardSalt,
    parallelism: BRAINVAULT_V1.ARGON_PARALLELISM,
    iterations: BRAINVAULT_V1.ARGON_TIME_COST,
    memorySize: memorySizeKb,
    hashLength: BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
    outputType: 'binary',
  });
  return new Uint8Array(result);
}

// Message handler
self.onmessage = async function(e: MessageEvent) {
  const { type, data, id } = e.data;

  try {
    switch (type) {
      case 'init':
        self.postMessage({ type: 'ready', id });
        break;

      case 'probe': {
        const probeStart = performance.now();
        await argon2id({
          password: 'probe',
          salt: new Uint8Array(32),
          parallelism: 1,
          iterations: 1,
          memorySize: 16 * 1024, // 16MB probe
          hashLength: 32,
          outputType: 'binary',
        });
        const probeTime = performance.now() - probeStart;
        const estimatedShardTime = probeTime * 16; // Scale to 256MB
        self.postMessage({
          type: 'probe_result',
          id,
          data: { estimatedShardTimeMs: estimatedShardTime }
        });
        break;
      }

      case 'derive_shard': {
        const { name, passphrase, shardIndex, shardCount, shardMemoryKb, algId } = data;
        if (!name || !passphrase) throw new Error('Missing name or passphrase');
        const memorySizeKb = typeof shardMemoryKb === 'number' ? shardMemoryKb : BRAINVAULT_V1.SHARD_MEMORY_KB;
        const effectiveAlgId = typeof algId === 'string' && algId.length > 0 ? algId : BRAINVAULT_V1.ALG_ID;

        const startTime = performance.now();
        const salt = createShardSalt(name, shardIndex, shardCount, effectiveAlgId);
        const result = await deriveShard(passphrase, salt, memorySizeKb);
        const elapsed = performance.now() - startTime;

        self.postMessage({
          type: 'shard_complete',
          id,
          data: {
            shardIndex,
            resultHex: bytesToHex(result),
            elapsedMs: elapsed,
          }
        });
        break;
      }

      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      data: { message: (error as Error).message, stack: (error as Error).stack }
    });
  }
};
