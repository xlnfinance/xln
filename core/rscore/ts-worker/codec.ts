import {
  createSequentialTransportValueCodec,
} from '../../protocol/serialization/binary-codec';

export class TsAccountWorkerTransferEncoder {
  readonly #codec = createSequentialTransportValueCodec();

  /** Pack once and transfer ownership of the exact backing buffer. */
  encode(value: unknown): ArrayBuffer {
    const bytes = this.#codec.pack(value);
    if (bytes.buffer instanceof ArrayBuffer
      && bytes.byteOffset === 0
      && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    return owned.buffer;
  }
}

export class TsAccountWorkerTransferDecoder {
  readonly #codec = createSequentialTransportValueCodec();

  decode(buffer: ArrayBuffer): unknown {
    return this.#codec.unpack(new Uint8Array(buffer));
  }
}
