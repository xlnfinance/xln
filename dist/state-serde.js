import { Packr } from 'msgpackr';
// msgpackr can be extended to support types that are not in the MessagePack specification.
// We configure a single Packr instance with a custom "structure" for BigInt.
// The structure is an array: [Class, serializer, deserializer]
const packr = new Packr({
    structures: [[BigInt, (value) => value.toString(), (str) => BigInt(str)]],
});
/**
 * Encodes the entire server state into a Buffer using MessagePack.
 * This is a highly efficient binary format that is much more compact
 * than JSON and supports types like BigInt via extensions.
 *
 * @param state - The XLNEnv object to serialize.
 * @returns A Buffer containing the serialized state.
 */
export function encodeState(state) {
    // Our configured packr instance now knows how to handle BigInts.
    return packr.pack(state);
}
/**
 * Decodes a Buffer back into the server state object.
 * It uses the same packr instance, which knows how to revive BigInts.
 *
 * @param buffer - The Buffer containing the serialized state.
 * @returns The deserialized XLNEnv object.
 */
export function decodeState(buffer) {
    // The 'unpack' function reconstructs the original object,
    // using the same structure definitions to revive BigInts.
    const decoded = packr.unpack(buffer);
    // A simple type guard to ensure the decoded object is not null or undefined.
    if (!decoded) {
        throw new Error('Failed to decode state: buffer resulted in a null/undefined object.');
    }
    return decoded;
}
// Example of a more specific type guard if we had a defined XLNEnv interface.
// This demonstrates how you could add more robust runtime type checking.
/*
interface XLNEnv {
  replicas: Map<string, any>;
  // ... other properties
}

export function isXLNEnv(obj: any): obj is XLNEnv {
  if (typeof obj !== 'object' || obj === null) return false;
  if (!(obj.replicas instanceof Map)) return false;
  // ... add more checks for other critical properties
  return true;
}

// Then in decodeState, you could do:
// const decoded = packr.unpack(buffer);
// if (isXLNEnv(decoded)) {
//   return decoded;
// } else {
//   throw new Error('Decoded object does not match the XLNEnv structure.');
// }
*/
