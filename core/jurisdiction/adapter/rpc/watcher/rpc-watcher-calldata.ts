import { ethers } from 'ethers';
import { Depository__factory } from '../../../../../jurisdictions/typechain-types';
import { decodeIncludedTronTransactionCall } from '../../operations/tron-transaction';
import { HANKO_MAX_BYTES } from '../../../../hanko/codec';
import { J_BATCH_CONTRACT_LIMITS } from '../../../machine/batch/limits';

/** Native SolidityNode `walletsolidity/gettransactionbyid` for one bare txID. */
export type SolidifiedTronTransactionReader = (txId: string) => Promise<unknown>;

/**
 * Calldata of a receipt-attested TRON transaction. The RPC log names the
 * transaction by 0x-prefixed txID; the native node returns raw_data_hex, and
 * sha256(raw_data) must equal that txID before its TriggerSmartContract data
 * is trusted. The eth-compatible RPC cannot serve this: its transaction has
 * no raw_data, and an Ethereum envelope hash never equals a TRON txID.
 */
export const readIncludedTronCalldata = async (
  readTransaction: SolidifiedTronTransactionReader,
  txHash: string,
): Promise<string> => {
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new Error(`J_DISPUTE_TX_HASH_INVALID:${txHash}`);
  const response = await readTransaction(txHash.slice(2));
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(`J_DISPUTE_TX_MISSING:${txHash}`);
  }
  const transaction = response as Record<string, unknown>;
  if (Object.keys(transaction).length === 0) throw new Error(`J_DISPUTE_TX_MISSING:${txHash}`);
  const claimed = typeof transaction['txID'] === 'string' ? `0x${transaction['txID'].toLowerCase()}` : '';
  if (claimed !== txHash) {
    throw new Error(`J_DISPUTE_TX_HASH_CLAIM_MISMATCH:${txHash}:${claimed || 'missing'}`);
  }
  const rawData = transaction['raw_data_hex'];
  try {
    if (typeof rawData !== 'string') throw new Error('TRON_RAW_DATA_MISSING');
    return decodeIncludedTronTransactionCall(txHash, `0x${rawData}`).data;
  } catch (error) {
    throw new Error(`J_DISPUTE_TX_HASH_INVALID:${txHash}`, { cause: error });
  }
};

const depositoryInterface: ethers.Interface = Depository__factory.createInterface();
const requireFunction = (name: string): ethers.FunctionFragment => {
  const fragment = depositoryInterface.getFunction(name);
  if (!fragment) throw new Error(`J_DISPUTE_CALL_FRAGMENT_MISSING:${name}`);
  return fragment;
};

const isDynamic = (param: ethers.ParamType): boolean =>
  param.baseType === 'bytes' || param.baseType === 'string' ||
  (param.isArray() && (param.arrayLength === -1 || isDynamic(param.arrayChildren))) ||
  (param.isTuple() && param.components.some(isDynamic));

/**
 * Where a canonical encoding of `fragment` must end, read from two words.
 * Canonical ABI lays dynamic tails out in argument order, and the last
 * dynamic argument of both dispute calls is `bytes`, so the call ends after
 * that tail. Every head slot is one word only while no argument is a static
 * tuple or fixed array; an ABI that breaks either property is refused at load.
 */
const canonicalLayout = (fragment: ethers.FunctionFragment): { lastSlot: number; headBytes: number } => {
  const { inputs } = fragment;
  if (inputs.some(input => (input.isTuple() || input.isArray()) && !isDynamic(input))) {
    throw new Error(`J_DISPUTE_CALL_STATIC_COMPOSITE_UNSUPPORTED:${fragment.name}`);
  }
  const lastSlot = inputs.findLastIndex(isDynamic);
  if (inputs[lastSlot]?.baseType !== 'bytes') throw new Error(`J_DISPUTE_CALL_LAST_TAIL_NOT_BYTES:${fragment.name}`);
  return { lastSlot, headBytes: 32 * inputs.length };
};

const DISPUTE_CALLS = [requireFunction('processBatch'), requireFunction('watchtowerCounterDispute')]
  .map(fragment => ({ fragment, selector: ethers.getBytes(fragment.selector), layout: canonicalLayout(fragment) }));
type DisputeCall = (typeof DISPUTE_CALLS)[number];

/**
 * Largest call Depository can execute: processBatch's head and two length
 * words plus its capped batch and hanko (watchtowerCounterDispute caps its
 * whole msg.data lower). A longer claimed call never ran.
 */
const MAX_EXECUTABLE_DISPUTE_CALL_BYTES = 4 + 5 * 32 + J_BATCH_CONTRACT_LIMITS.maxEncodedBatchBytes + HANKO_MAX_BYTES;

const matchesAt = (bytes: Uint8Array, offset: number, expected: Uint8Array): boolean =>
  offset + expected.length <= bytes.length && expected.every((byte, index) => bytes[offset + index] === byte);

/** A big-endian word that fits a safe integer, else null. */
const smallWordAt = (bytes: Uint8Array, offset: number): number | null => {
  if (offset < 0 || offset + 32 > bytes.length) return null;
  for (let index = offset; index < offset + 26; index += 1) if (bytes[index] !== 0) return null;
  return Number(ethers.toBigInt(bytes.subarray(offset + 26, offset + 32)));
};

const callAt = (bytes: Uint8Array, offset: number): DisputeCall | undefined =>
  DISPUTE_CALLS.find(call => matchesAt(bytes, offset, call.selector));

/**
 * The canonical ABI call starting at `offset`, or null when those bytes only
 * resemble one. Its exact length comes from two words before any decode, so a
 * decoy costs O(1) unless it also forges a consistent layout, and a decode
 * never reads past the call it claims to be.
 */
const canonicalCallAt = (bytes: Uint8Array, offset: number, call: DisputeCall): string | null => {
  const args = offset + 4;
  const lastOffset = smallWordAt(bytes, args + 32 * call.layout.lastSlot);
  if (lastOffset === null || lastOffset < call.layout.headBytes || lastOffset % 32 !== 0) return null;
  const lastLength = smallWordAt(bytes, args + lastOffset);
  if (lastLength === null) return null;
  const length = 4 + lastOffset + 32 + Math.ceil(lastLength / 32) * 32;
  if (length > MAX_EXECUTABLE_DISPUTE_CALL_BYTES || offset + length > bytes.length) return null;
  const candidate = ethers.hexlify(bytes.subarray(offset, offset + length));
  try {
    const encoded = depositoryInterface.encodeFunctionData(
      call.fragment,
      depositoryInterface.decodeFunctionData(call.fragment, candidate),
    );
    return encoded === candidate ? encoded : null;
  } catch {
    // A selector-shaped byte run inside foreign calldata is not a call.
    return null;
  }
};

/**
 * Exact Depository dispute calls embedded in wrapper calldata.
 *
 * Returns null for a direct processBatch/watchtowerCounterDispute call, which
 * keeps its strict decoder. A wrapper (Safe, ERC-4337, forwarder, packed
 * MultiSend) places the call at any byte offset, so every selector hit in the
 * whole calldata is checked and kept only when the bytes there are exactly
 * its canonical encoding.
 * A hit proves nothing about execution: callers accept a body only when it
 * matches the authenticated event exactly, proofbodyHash included, so a decoy
 * copy can never substitute a different body.
 */
export const extractEmbeddedDisputeCalls = (data: string): string[] | null => {
  const bytes = ethers.getBytes(data);
  if (bytes.length >= 4 && callAt(bytes, 0)) return null;
  const calls: string[] = [];
  for (let offset = 1; offset + 4 <= bytes.length; offset += 1) {
    const call = callAt(bytes, offset);
    const encoded = call ? canonicalCallAt(bytes, offset, call) : null;
    if (encoded) calls.push(encoded);
  }
  return calls;
};
