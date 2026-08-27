import {
  packTransportValue,
  unpackTransportValue,
} from '../../protocol/serialization/binary-codec';

/** Pack once and transfer ownership of the exact backing buffer to the other isolate. */
export const encodeTsAccountWorkerTransfer = (value: unknown): ArrayBuffer => {
  const bytes = packTransportValue(value);
  if (
    bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
};

export const decodeTsAccountWorkerTransfer = (buffer: ArrayBuffer): unknown =>
  unpackTransportValue(new Uint8Array(buffer));
