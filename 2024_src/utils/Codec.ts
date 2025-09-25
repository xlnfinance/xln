import * as msgpack from '@msgpack/msgpack';

const extensionCodec = new msgpack.ExtensionCodec();
extensionCodec.register({
  type: 0,
  encode(input: unknown): Uint8Array | null {
    if (typeof input === 'bigint') {
      if (input <= Number.MAX_SAFE_INTEGER && input >= Number.MIN_SAFE_INTEGER) {
        return msgpack.encode(Number(input));
      } else {
        return msgpack.encode(String(input));
      }
    } else {
      return null;
    }
  },
  decode(data: Uint8Array): bigint {
    const val = msgpack.decode(data);
    if (!(typeof val === 'string' || typeof val === 'number')) {
      throw new Error(`unexpected BigInt source: ${val} (${typeof val})`);
    }
    return BigInt(val);
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function encode(data: any): Buffer {
  // todo: reusing Encoder instance is about 20% faster than encode() function
  return Buffer.from(msgpack.encode(data, { extensionCodec }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decode(data: Buffer): any {
  return msgpack.decode(data, { extensionCodec });
}
