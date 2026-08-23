import secp256k1 from 'secp256k1';
import { keccak256Bytes } from '../../core/protocol/crypto/fast/fast-keccak';

type Request = { id: number; records: Uint8Array };

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, records } = event.data;
  const count = records.length / 97;
  const output = new Uint8Array(count * 20);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 97;
    const publicKey = secp256k1.ecdsaRecover(
      records.subarray(offset + 32, offset + 96),
      records[offset + 96]!,
      records.subarray(offset, offset + 32),
      false,
    );
    output.set(keccak256Bytes(publicKey.subarray(1)).subarray(12), index * 20);
  }
  postMessage({ id, output }, [output.buffer]);
};
