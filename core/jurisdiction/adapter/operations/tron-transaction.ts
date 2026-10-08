import { ethers } from 'ethers';

type Field = { wire: 0; value: bigint } | { wire: 2; value: Uint8Array };

const fields = (input: Uint8Array, allowed: number[]): Map<number, Field> => {
  let offset = 0;
  const read = (): bigint => {
    let value = 0n;
    for (let count = 0; count < 10 && offset < input.length; count += 1) {
      const byte = input[offset];
      if (byte === undefined) throw new Error('TRON_PROTOBUF_TRUNCATED');
      offset += 1;
      value |= BigInt(byte & 127) << BigInt(count * 7);
      if (byte < 128) {
        if (count > 0 && byte === 0) throw new Error('TRON_PROTOBUF_NON_CANONICAL');
        return value;
      }
    }
    throw new Error('TRON_PROTOBUF_VARINT_INVALID');
  };
  const result = new Map<number, Field>();
  let prior = 0;
  while (offset < input.length) {
    const key = read();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (!allowed.includes(field) || field <= prior) throw new Error('TRON_PROTOBUF_FIELD_INVALID');
    prior = field;
    if (wire === 0) result.set(field, { wire: 0, value: read() });
    else if (wire === 2) {
      const size = Number(read());
      if (!Number.isSafeInteger(size) || size < 0 || size > input.length - offset) throw new Error('TRON_PROTOBUF_LENGTH_INVALID');
      result.set(field, { wire: 2, value: input.slice(offset, offset + size) });
      offset += size;
    } else throw new Error('TRON_PROTOBUF_WIRE_INVALID');
  }
  return result;
};

const bytes = (input: Map<number, Field>, field: number, length?: number): Uint8Array => {
  const value = input.get(field);
  if (!value || value.wire !== 2 || (length !== undefined && value.value.length !== length)) {
    throw new Error(`TRON_PROTOBUF_BYTES_INVALID:${field}`);
  }
  return value.value;
};
const number = (input: Map<number, Field>, field: number): bigint => {
  const value = input.get(field);
  if (!value || value.wire !== 0 || value.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`TRON_PROTOBUF_NUMBER_INVALID:${field}`);
  }
  return value.value;
};
const address = (value: Uint8Array): string => {
  if (value.length !== 21 || value[0] !== 0x41) throw new Error('TRON_TRANSACTION_ADDRESS_INVALID');
  return ethers.hexlify(value.slice(1)).toLowerCase();
};

/** Validate the native signed wire, without inventing an embedded EVM chain id.
 * Its domain is the selected, chain-verified native RPC plus signed TAPOS. */
export const decodeSignedTronTransaction = (rawTransaction: string) => {
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(rawTransaction) || rawTransaction.length > 524_290) {
    throw new Error('TRON_SIGNED_TRANSACTION_INVALID');
  }
  const transaction = fields(ethers.getBytes(rawTransaction), [1, 2]);
  const raw = bytes(transaction, 1);
  const signature = bytes(transaction, 2, 65);
  if (signature[64] !== 27 && signature[64] !== 28) throw new Error('TRON_SIGNATURE_RECOVERY_INVALID');
  const data = fields(raw, [1, 4, 8, 11, 14, 18]);
  const refBlockBytes = ethers.hexlify(bytes(data, 1, 2));
  const refBlockHash = ethers.hexlify(bytes(data, 4, 8));
  const expiration = number(data, 8);
  const timestamp = number(data, 14);
  const feeLimit = number(data, 18);
  if (timestamp <= 0n || expiration !== timestamp + 60_000n || feeLimit <= 0n || feeLimit > 15_000_000_000n) {
    throw new Error('TRON_TRANSACTION_LIFETIME_OR_FEE_INVALID');
  }
  const contract = fields(bytes(data, 11), [1, 2]);
  if (number(contract, 1) !== 31n) throw new Error('TRON_CONTRACT_TYPE_INVALID');
  const parameter = fields(bytes(contract, 2), [1, 2]);
  if (ethers.toUtf8String(bytes(parameter, 1)) !== 'type.googleapis.com/protocol.TriggerSmartContract') {
    throw new Error('TRON_CONTRACT_PARAMETER_INVALID');
  }
  const call = fields(bytes(parameter, 2), [1, 2, 3, 4]);
  const from = address(bytes(call, 1, 21));
  const to = address(bytes(call, 2, 21));
  const hash = ethers.sha256(raw);
  if (ethers.recoverAddress(hash, ethers.hexlify(signature)).toLowerCase() !== from) {
    throw new Error('TRON_TRANSACTION_SIGNER_MISMATCH');
  }
  return { hash, from, to, data: ethers.hexlify(bytes(call, 4)), value: call.has(3) ? number(call, 3) : 0n,
    nonce: 0, refBlockBytes, refBlockHash, expiration, timestamp, feeLimit };
};
