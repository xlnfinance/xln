/**
 * BrainVault Web Worker - Parallel Shard Computation
 *
 * This worker handles argon2id shard derivation off the main thread.
 * Multiple workers can run in parallel to utilize all CPU cores.
 */

// Import hash-wasm dynamically
let argon2id = null;
let blake3 = null;

const BRAINVAULT_V2 = {
  ALG_ID: 'brainvault/argon2id-sharded/v2.0',
  SHARD_MEMORY_KB: 256 * 1024,    // 256MB per shard
  ARGON_TIME_COST: 1,
  ARGON_PARALLELISM: 1,
  SHARD_OUTPUT_BYTES: 32,
};

// Initialize hash-wasm
async function initCrypto() {
  if (argon2id && blake3) return;

  const hashWasm = await import('https://esm.sh/hash-wasm@4.12.0');
  argon2id = hashWasm.argon2id;
  blake3 = hashWasm.blake3;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create salt for a specific shard
 */
async function createShardSalt(nameHashHex, shardIndex) {
  const nameHash = hexToBytes(nameHashHex);

  // salt = BLAKE3(nameHash || ALG_ID || shardIndex as uint32 BE)
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, shardIndex, false);

  const algIdBytes = new TextEncoder().encode(BRAINVAULT_V2.ALG_ID);

  const combined = new Uint8Array(nameHash.length + algIdBytes.length + 4);
  combined.set(nameHash, 0);
  combined.set(algIdBytes, nameHash.length);
  combined.set(indexBytes, nameHash.length + algIdBytes.length);

  const hash = await blake3(combined);
  return hexToBytes(hash);
}

/**
 * Derive a single shard
 */
async function deriveShard(passphrase, shardSalt) {
  const result = await argon2id({
    password: passphrase,
    salt: shardSalt,
    parallelism: BRAINVAULT_V2.ARGON_PARALLELISM,
    iterations: BRAINVAULT_V2.ARGON_TIME_COST,
    memorySize: BRAINVAULT_V2.SHARD_MEMORY_KB,
    hashLength: BRAINVAULT_V2.SHARD_OUTPUT_BYTES,
    outputType: 'binary',
  });

  return new Uint8Array(result);
}

// Message handler
self.onmessage = async function(e) {
  const { type, data, id } = e.data;

  try {
    switch (type) {
      case 'init':
        await initCrypto();
        self.postMessage({ type: 'ready', id });
        break;

      case 'probe':
        // Run a small probe to estimate time per shard
        await initCrypto();
        const probeStart = performance.now();

        // Use smaller memory for probe (16MB instead of 256MB)
        await argon2id({
          password: 'probe',
          salt: new Uint8Array(32),
          parallelism: 1,
          iterations: 1,
          memorySize: 16 * 1024, // 16MB
          hashLength: 32,
          outputType: 'binary',
        });

        const probeTime = performance.now() - probeStart;
        // Estimate 256MB time = 16MB time * 16 (linear with memory)
        const estimatedShardTime = probeTime * 16;

        self.postMessage({
          type: 'probe_result',
          id,
          data: { estimatedShardTimeMs: estimatedShardTime }
        });
        break;

      case 'hash_name':
        // Hash a name using BLAKE3
        await initCrypto();
        const nameToHash = data.name;
        const nameHashResult = await blake3(new TextEncoder().encode(nameToHash));
        self.postMessage({
          type: 'name_hashed',
          id,
          data: { nameHashHex: nameHashResult }
        });
        break;

      case 'blake3':
        // General purpose BLAKE3 hash (for combining shards, deriving keys, etc.)
        await initCrypto();
        const inputBytes = hexToBytes(data.inputHex);
        const hashResult = await blake3(inputBytes);
        self.postMessage({
          type: 'blake3_result',
          id,
          data: { resultHex: hashResult }
        });
        break;

      case 'derive_shard':
        await initCrypto();
        const { nameHashHex, passphrase, shardIndex } = data;

        const startTime = performance.now();
        const salt = await createShardSalt(nameHashHex, shardIndex);
        const result = await deriveShard(passphrase, salt);
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

      case 'derive_batch':
        // Batch mode: process multiple shards sequentially in this worker
        // Reduces round-trip overhead (main ↔ worker messaging)
        await initCrypto();
        const { nameHashHex: nameHash, passphrase: pass, shardIndices } = data;
        const batchResults = [];

        for (const idx of shardIndices) {
          const batchStart = performance.now();
          const shardSalt = await createShardSalt(nameHash, idx);
          const shardResult = await deriveShard(pass, shardSalt);

          batchResults.push({
            shardIndex: idx,
            resultHex: bytesToHex(shardResult),
            elapsedMs: performance.now() - batchStart
          });

          // Send progress for each shard in batch
          self.postMessage({
            type: 'shard_complete',
            id,
            data: batchResults[batchResults.length - 1]
          });
        }

        // Signal batch completion
        self.postMessage({
          type: 'batch_complete',
          id,
          data: { count: batchResults.length }
        });
        break;

      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      data: { message: error.message, stack: error.stack }
    });
  }
};
