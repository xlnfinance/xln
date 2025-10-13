/**
 * Unified encoder/decoder for snapshots with configurable JSON/msgpack methods.
 * Set USE_MSGPACK = true for msgpack with integrity hashing, false for simple JSON.
 */

// Configuration flag - change this to test different encoders
const USE_MSGPACK = false;

// JSON encoder imports and setup
const jsonReplacer = (key: string, value: any) => {
  if (key === 'clonedForValidation') {
    return undefined;
  }
  if (value instanceof Map) {
    return { _dataType: 'Map', value: Array.from(value.entries()) };
  }
  if (typeof value === 'bigint') {
    return { _dataType: 'BigInt', value: value.toString() };
  }
  return value;
};

const jsonReviver = (_key: string, value: any) => {
  if (typeof value === 'object' && value !== null) {
    if (value._dataType === 'Map') return new Map(value.value);
    if (value._dataType === 'BigInt') return BigInt(value.value);
  }
  return value;
};

// Msgpack encoder setup - lazy initialization to avoid browser issues
let packr: any = null;
let sha256: any = null;

// Lazy initialization function for msgpack
const initMsgpack = async () => {
  if (packr) return packr; // Already initialized

  try {
    const { Packr } = await import('msgpackr');
    const { createHash } = await import('./utils.js');

    sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest();

    packr = new Packr({
      structures: [[BigInt, (value: bigint) => value.toString(), (str: string) => BigInt(str)]],
    });

    return packr;
  } catch (error) {
    console.warn('Failed to load msgpack dependencies:', error);
    throw error;
  }
};

/**
 * Recursively traverses an object and converts any Map instances into
 * arrays of [key, value] pairs, sorted by key. This is essential for
 * ensuring that serialization is deterministic.
 */
function deterministicDeepSort(obj: any): any {
  if (obj instanceof Map) {
    const entries = Array.from(obj.entries());
    // Sort entries by key to ensure deterministic output.
    entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    // Recursively process values in case they contain Maps.
    return entries.map(([k, v]) => [k, deterministicDeepSort(v)]);
  }
  if (Array.isArray(obj)) {
    return obj.map(deterministicDeepSort);
  }
  if (typeof obj === 'object' && obj !== null) {
    const newObj: { [key: string]: any } = {};
    const sortedKeys = Object.keys(obj).sort();
    for (const key of sortedKeys) {
      newObj[key] = deterministicDeepSort(obj[key]);
    }
    return newObj;
  }
  return obj;
}

/**
 * Reconstructs Map objects from the key-sorted arrays created by deterministicDeepSort.
 * This is the reverse operation used during deserialization.
 */
function reconstructMaps(obj: any): any {
  if (Array.isArray(obj)) {
    // Check if it's a key-value pair array that should be a Map
    const isMapArray = obj.every(item => Array.isArray(item) && item.length === 2);
    if (isMapArray) {
      return new Map(obj.map(([k, v]) => [k, reconstructMaps(v)]));
    }
    return obj.map(reconstructMaps);
  }
  if (typeof obj === 'object' && obj !== null) {
    const newObj: { [key: string]: any } = {};
    for (const key in obj) {
      newObj[key] = reconstructMaps(obj[key]);
    }
    return newObj;
  }
  return obj;
}

// Define the structure of the persisted tuple for msgpack format
type SnapshotTuple = [
  number, // height
  any, // serverInput
  Buffer, // hashOfSerializedReplicas
  any, // deterministically sorted replicas
];

/**
 * Encodes data using the configured method (JSON or msgpack)
 */
export const encode = (data: any): Buffer => {
  // ENCODE validation removed - too verbose
  // Auto-fix jBlock corruption if needed
  if (data && data.replicas) {
    for (const [replicaKey, replica] of data.replicas.entries()) {
      if (replica && replica.state && typeof replica.state.jBlock !== 'number') {
        console.error(`💥 CRITICAL: Invalid jBlock for ${replicaKey.slice(0,20)}... - auto-fixing to 0`);
        replica.state.jBlock = 0;
      }
    }
  }

  if (USE_MSGPACK) {
    // For msgpack mode, we need to use async initialization
    // This should not happen in current config (USE_MSGPACK = false)
    throw new Error('Msgpack mode requires async initialization - use encodeAsync instead');
  } else {
    // Simple JSON encoding
    return Buffer.from(JSON.stringify(data, jsonReplacer));
  }
};

/**
 * Decodes data using the configured method (JSON or msgpack)
 */
export const decode = (buffer: Buffer): any => {
  if (USE_MSGPACK) {
    // For msgpack mode, we need to use async initialization
    // This should not happen in current config (USE_MSGPACK = false)
    throw new Error('Msgpack mode requires async initialization - use decodeAsync instead');
  } else {
    // Simple JSON decoding
    const decoded = JSON.parse(buffer.toString(), jsonReviver);

    // CRITICAL: Validate financial state integrity after deserialization
    if (decoded && decoded.replicas) {
      for (const [replicaKey, replica] of decoded.replicas.entries()) {
        if (replica && replica.state) {
          const jBlock = replica.state.jBlock;
          if (typeof jBlock !== 'number') {
            // IMPORTANT: Don't reset to 0 - this causes re-processing of ALL events!
            // If jBlock is missing, use the snapshot height as a safe fallback
            const fallbackJBlock = Number(decoded.height) || 0;
            console.warn(`⚠️ jBlock missing for replica ${replicaKey}, using height ${fallbackJBlock} as fallback`);
            replica.state.jBlock = fallbackJBlock;
          }
        }
      }
    }

    return decoded;
  }
};

/**
 * Async version for msgpack encoding
 */
export const encodeAsync = async (data: any): Promise<Buffer> => {
  if (USE_MSGPACK) {
    const packrInstance = await initMsgpack();

    // Msgpack encoding with integrity hashing
    const sortedReplicas = deterministicDeepSort(data.replicas || new Map());
    const serializedReplicas = packrInstance.pack(sortedReplicas);
    const hashOfReplicas = sha256(serializedReplicas);

    const snapshotTuple: SnapshotTuple = [
      data.height || 0,
      deterministicDeepSort(data.serverInput || {}),
      hashOfReplicas,
      sortedReplicas,
    ];

    return packrInstance.pack(snapshotTuple);
  } else {
    // Fallback to sync JSON encoding
    return encode(data);
  }
};

/**
 * Async version for msgpack decoding
 */
export const decodeAsync = async (buffer: Buffer): Promise<any> => {
  if (USE_MSGPACK) {
    const packrInstance = await initMsgpack();

    // Msgpack decoding with integrity verification
    const decodedTuple = packrInstance.unpack(buffer) as SnapshotTuple;

    if (!Array.isArray(decodedTuple) || decodedTuple.length !== 4) {
      throw new Error('Invalid snapshot format: Expected a 4-element tuple.');
    }

    const [height, serverInput, hashOfReplicas, sortedReplicas] = decodedTuple;

    // Security/Integrity Check: Verify the hash of the replicas.
    const serializedReplicas = packrInstance.pack(sortedReplicas);
    const calculatedHash = sha256(serializedReplicas);
    // Browser-compatible buffer comparison
    if (hashOfReplicas.toString('hex') !== calculatedHash.toString('hex')) {
      throw new Error('State integrity check failed: Replica hash does not match.');
    }

    // Reconstruct the original object, converting sorted arrays back to Maps.
    const replicas = reconstructMaps(sortedReplicas);

    return {
      height,
      serverInput: reconstructMaps(serverInput),
      replicas,
      // Add timestamp for compatibility
      timestamp: Date.now(),
      // Note: gossip layer will be re-created by runtime on restore
    };
  } else {
    // Fallback to sync JSON decoding
    return decode(buffer);
  }
};

// Export the configuration flag for external use/testing
export { USE_MSGPACK };
