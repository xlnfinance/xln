import { ethers } from 'ethers';
import { DepositoryBounds__factory } from '../../../../../jurisdictions/typechain-types';
import { PROOF_BODY_ABI } from '../../../../protocol/dispute/proof-body';
import { body, depository, finalizationCall, startCall, word } from '../../../helpers/jurisdiction/dispute-calldata-fixtures';

// Xorshift32: reproducible layout corpus, independent of wall time and execution order.
export const layouts = (count: number): string[] => {
  let seed = 0x51c0dec;
  const random = (max: number): number => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % max;
  };
  return Array.from({ length: count }, (_, index) => layout(index % 24, random));
};
const read = (bytes: Uint8Array, slot: number): number => Number(ethers.toBigInt(bytes.subarray(slot, slot + 32)));
const shortBody = { ...body, transformers: [{ ...body.transformers[0]!, encodedBatch: '0xab' }] };
const canonicalBatch = (): Uint8Array => ethers.getBytes(depository.decodeFunctionData('processBatch', startCall(shortBody))[0]);

const mutateBatch = (kind: number, random: (max: number) => number): Uint8Array => {
  let bytes = canonicalBatch();
  const root = read(bytes, 0);
  const starts = root + read(bytes, root + 4 * 32);
  const start = starts + 32 + read(bytes, starts + 32);
  const proof = start + read(bytes, start + 4 * 32);
  const transformers = proof + read(bytes, proof + 5 * 32);
  const transformer = transformers + 32 + read(bytes, transformers + 32);
  const payload = transformer + read(bytes, transformer + 32);
  if (kind === 6) bytes[payload + 33 + random(31)] = 1 + random(255);
  if (kind === 7) {
    // Bytes data may end exactly at dataEnd, with no rounded padding.
    const tail = new Uint8Array(bytes.length + 33);
    tail.set(bytes); word(tail, transformer + 32, bytes.length - transformer);
    word(tail, bytes.length, 1); tail[tail.length - 1] = 0xab; bytes = tail;
  }
  if (kind === 8) {
    const gap = 1 + random(63);
    const shifted = new Uint8Array(bytes.length + gap);
    shifted.set(bytes.subarray(32), 32 + gap); word(shifted, 0, 32 + gap); bytes = shifted;
  }
  if (kind === 9) word(bytes, proof + 32, 2 ** 32 + random(100)); // Dirty uint32.
  if (kind === 10) word(bytes, start + 2 * 32, 2 + random(100)); // Noncanonical bool.
  if (kind === 11) word(bytes, root + 4 * 32, bytes.length + random(100));
  if (kind === 12) word(bytes, proof + 3 * 32, random(96)); // Aliased/overlapping inner heads.
  if (kind === 13) word(bytes, 0, random(32));
  if (kind === 17) bytes.set(ethers.getBytes(ethers.toBeHex(1n << 200n, 32)), start + 32);
  // Layout mutations may intentionally alias a different decoded body. Keep the
  // start's claimed hash honest so I6 does not reject an otherwise valid layout.
  try {
    const param = DepositoryBounds__factory.createInterface().getFunction('assertBatch')!.inputs[0]!;
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode([param], bytes, true)[0];
    const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_ABI], [decoded.disputeStarts[0].initialProofbody]));
    const actualRoot = read(bytes, 0);
    const actualStarts = actualRoot + read(bytes, actualRoot + 4 * 32);
    const actualStart = actualStarts + 32 + read(bytes, actualStarts + 32);
    bytes.set(ethers.getBytes(hash), actualStart + 3 * 32);
  } catch { /* Invalid ABI is deliberately retained for the EVM rejection oracle. */ }
  return bytes;
};

const layout = (kind: number, random: (max: number) => number): string => {
  if (kind >= 18) return watchtowerLayout(kind, random);
  const batch = mutateBatch(kind, random);
  const batchOffset = kind === 1 ? 64 : kind === 2 ? 65 + random(31) : 96 + random(64);
  const hankoOffset = kind === 1 || kind === 2 ? batchOffset : batchOffset + 32 + batch.length + random(64);
  const end = Math.max(100, 4 + batchOffset + 32 + batch.length, 4 + hankoOffset + 33);
  const bytes = new Uint8Array(end + (kind === 3 ? random(160) : 0));
  bytes.set(ethers.getBytes(depository.getFunction('processBatch')!.selector));
  word(bytes, 4, batchOffset); word(bytes, 36, hankoOffset); word(bytes, 68, random(100));
  word(bytes, 4 + batchOffset, batch.length); bytes.set(batch, 4 + batchOffset + 32);
  if (hankoOffset !== batchOffset) { word(bytes, 4 + hankoOffset, 1); bytes[4 + hankoOffset + 32] = 1; }
  if (kind === 4) return ethers.hexlify(bytes.subarray(0, end - random(32) - 1));
  if (kind === 5) word(bytes, 36, batchOffset); // Fully shared bytes tails.
  if (kind === 14) word(bytes, 4, random(64));
  if (kind === 15) bytes[4] = 0x80; // Offset above solc's uint64 ceiling.
  if (kind === 16) return ethers.concat(['0x12345678', bytes]); // Forwarded, not a direct call.
  if (kind === 17) return ethers.concat([bytes, startCall()]); // Selector-shaped trailing junk.
  return ethers.hexlify(bytes);
};

const watchtowerLayout = (kind: number, random: (max: number) => number): string => {
  const original = ethers.getBytes(finalizationCall());
  const gap = random(64);
  const bytes = new Uint8Array(original.length + gap);
  bytes.set(original.subarray(0, 164)); bytes.set(original.subarray(164), 164 + gap);
  word(bytes, 36, read(original, 36) + gap); word(bytes, 132, read(original, 132) + gap);
  const proof = 4 + read(bytes, 36);
  if (kind === 18) return ethers.hexlify(bytes.subarray(0, bytes.length - 31)); // Unpadded owner bytes.
  if (kind === 19) bytes[bytes.length - 1] = 1 + random(255);
  if (kind === 20) word(bytes, proof + 3 * 32, 2 + random(50));
  if (kind === 21) word(bytes, proof + 5 * 32, random(96));
  if (kind === 22) word(bytes, 36, random(160));
  if (kind === 23) bytes.set(ethers.getBytes(ethers.toBeHex(1n << 200n, 32)), proof + 2 * 32);
  if (kind === 23) return ethers.concat([bytes, depository.encodeFunctionData('processBatch', ['0x', '0x', 1])]);
  return ethers.hexlify(bytes);
};
