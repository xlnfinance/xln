/**
 * BrainVault Browser Worker
 *
 * frontend/copy-static-files.js builds this source for browser use.
 * The generated bundle is intentionally not tracked.
 *
 * Uses hash-wasm because browsers execute the portable WebAssembly backend.
 *
 * AUDITOR NOTE: the specId handshake prevents a cached generated worker from
 * silently deriving a different wallet after the UI updates. A loud mismatch
 * is recoverable; a plausible-looking address from stale code is not.
 */

import { argon2id } from 'hash-wasm';
import { bytesToHex } from './primitives/encoding.ts';
import { deriveShardWithParams } from './primitives/kdf.ts';
import { BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID, createShardSalt } from './primitives/spec.ts';

// Message handler
self.onmessage = async function(e: MessageEvent) {
  const { type, data, id } = e.data;

  try {
    switch (type) {
      case 'init':
        self.postMessage({ type: 'ready', id, data: { specId: BRAINVAULT_V1_SPEC_ID } });
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
        const memorySizeKb = typeof shardMemoryKb === 'number' ? shardMemoryKb : BRAINVAULT_V1.SHARD_MEMORY_KB;
        const effectiveAlgId = typeof algId === 'string' && algId.length > 0 ? algId : BRAINVAULT_V1.ALG_ID;

        const startTime = performance.now();
        const salt = await createShardSalt(name, shardIndex, shardCount, effectiveAlgId);
        const result = await deriveShardWithParams(passphrase, salt, { shardMemoryKb: memorySizeKb });
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
