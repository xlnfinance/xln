const HEX_NIBBLE = new Int8Array(128).fill(-1);
for (let value = 0; value < 16; value += 1) {
  HEX_NIBBLE['0123456789abcdef'.charCodeAt(value)] = value;
  HEX_NIBBLE['0123456789ABCDEF'.charCodeAt(value)] = value;
}

/** Bytes of a `0x`-prefixed even-length hex string; throws on malformed input. */
export const hexToBytes = (hex: string): Uint8Array => {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || hex.charCodeAt(0) !== 0x30 || (hex.charCodeAt(1) | 0x20) !== 0x78) {
    throw new Error(`HEX_BYTES_INVALID:${String(hex).slice(0, 16)}`);
  }
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const high = HEX_NIBBLE[hex.charCodeAt(index * 2 + 2)] ?? -1;
    const low = HEX_NIBBLE[hex.charCodeAt(index * 2 + 3)] ?? -1;
    if (high < 0 || low < 0) throw new Error(`HEX_BYTES_INVALID:${hex.slice(0, 16)}`);
    bytes[index] = (high << 4) | low;
  }
  return bytes;
};
