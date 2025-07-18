import { Packr } from 'msgpackr';
import { createHash } from 'node:crypto';

// Reusable hashing function
const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest();

// We use a single Packr instance configured to handle BigInts.
const packr = new Packr({
  structures: [[BigInt, (value: bigint) => value.toString(), (str: string) => BigInt(str)]],
});

/**
 * Recursively traverses an object and converts any Map instances into
 * arrays of [key, value] pairs, sorted by key. This is essential for
 * ensuring that serialization is deterministic.
 * @param obj The object to traverse.
 * @returns A new object with all Maps replaced by sorted arrays.
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
 * @param obj The object to traverse.
 * @returns A new object with sorted arrays converted back into Maps.
 */
function reconstructMaps(obj: any): any {
  if (Array.isArray(obj)) {
    // Check if it's a key-value pair array that should be a Map
    const isMapArray = obj.every((item) => Array.isArray(item) && item.length === 2);
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

// Define the structure of the environment object for type safety
interface XLNEnv {
  height: number;
  timestamp: number;
  replicas: Map<string, any>;
  serverInput: any;
  // ... add other top-level properties of your environment state
}

// Define the structure of the persisted tuple for clarity
type SnapshotTuple = [
  number, // height
  any, // serverInput (assuming this is what you meant by inputs/outputs)
  Buffer, // hashOfSerializedReplicas
  any, // deterministically sorted replicas
];

/**
 * Encodes the server state into a deterministic Buffer according to the specified tuple format.
 * @param state - The full XLNEnv object.
 * @returns A Buffer containing the MessagePack-encoded snapshot tuple.
 */
export function encodeState(state: XLNEnv): Buffer {
  // 1. Create a deterministically sorted version of the replicas map.
  const sortedReplicas = deterministicDeepSort(state.replicas);

  // 2. Serialize and hash the sorted replicas to create a deterministic hash.
  const serializedReplicas = packr.pack(sortedReplicas);
  const hashOfReplicas = sha256(serializedReplicas);

  // 3. Construct the final snapshot tuple as requested.
  const snapshotTuple: SnapshotTuple = [
    state.height,
    // Assuming serverInput contains the relevant inputs/outputs for the snapshot
    // If inputs/outputs are separate, they should be passed in and included here.
    deterministicDeepSort(state.serverInput),
    hashOfReplicas,
    sortedReplicas,
  ];

  // 4. Pack the entire tuple into a single buffer.
  return packr.pack(snapshotTuple);
}

/**
 * Decodes a Buffer back into the server state object.
 * @param buffer - The buffer containing the snapshot tuple.
 * @returns The reconstructed XLNEnv object.
 */
export function decodeState(buffer: Buffer): XLNEnv {
  const decodedTuple = packr.unpack(buffer) as SnapshotTuple;

  if (!Array.isArray(decodedTuple) || decodedTuple.length !== 4) {
    throw new Error('Invalid snapshot format: Expected a 4-element tuple.');
  }

  const [height, serverInput, hashOfReplicas, sortedReplicas] = decodedTuple;

  // Security/Integrity Check: Verify the hash of the replicas.
  const serializedReplicas = packr.pack(sortedReplicas);
  const calculatedHash = sha256(serializedReplicas);
  if (Buffer.compare(hashOfReplicas, calculatedHash) !== 0) {
    throw new Error('State integrity check failed: Replica hash does not match.');
  }

  // Reconstruct the original object, converting sorted arrays back to Maps.
  const replicas = reconstructMaps(sortedReplicas);

  const state: Partial<XLNEnv> = {
    height,
    serverInput: reconstructMaps(serverInput),
    replicas,
  };

  // Add back any non-serialized parts of the environment here if needed.
  // state.timestamp = ... // timestamp might be the time of restore, or stored separately.

  return state as XLNEnv;
}
