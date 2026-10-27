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
  param.baseType === 'bytes' ||
  param.baseType === 'string' ||
  (param.isArray() && (param.arrayLength === -1 || isDynamic(param.arrayChildren))) ||
  (param.isTuple() && param.components.some(isDynamic));

/**
 * Where a canonical encoding of `fragment` must end, before walking its tails.
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

const DISPUTE_CALLS = [requireFunction('processBatch'), requireFunction('watchtowerCounterDispute')].map(fragment => ({
  fragment,
  selector: ethers.getBytes(fragment.selector),
  layout: canonicalLayout(fragment),
}));
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

/** Static composites occupy their full head; dynamic values occupy one offset. */
const headBytes = (param: ethers.ParamType): number => {
  if (isDynamic(param)) return 32;
  if (param.isTuple()) return param.components.reduce((size, child) => size + headBytes(child), 0);
  if (param.isArray()) return param.arrayLength * headBytes(param.arrayChildren);
  return 32;
};

/** Require contiguous, ordered tails, including nested tuple/array offsets. */
const canonicalTupleEnd = (
  bytes: Uint8Array,
  start: number,
  limit: number,
  count: number,
  paramAt: (index: number) => ethers.ParamType | undefined,
): number | null => {
  // Every element consumes at least one word; reject forged counts before looping.
  if (count > (limit - start) / 32) return null;
  let tail = 0;
  for (let index = 0; index < count; index += 1) {
    const param = paramAt(index);
    if (!param) throw new Error('J_DISPUTE_CALL_LAYOUT_PARAM_MISSING');
    tail += headBytes(param);
  }
  if (start + tail > limit) return null;
  let slot = start;
  for (let index = 0; index < count; index += 1) {
    const param = paramAt(index);
    if (!param) throw new Error('J_DISPUTE_CALL_LAYOUT_PARAM_MISSING');
    if (isDynamic(param)) {
      if (smallWordAt(bytes, slot) !== tail) return null;
      const end = canonicalTailEnd(bytes, start + tail, limit, param);
      if (end === null) return null;
      tail = end - start;
    }
    slot += headBytes(param);
  }
  return start + tail;
};

const canonicalTailEnd = (bytes: Uint8Array, start: number, limit: number, param: ethers.ParamType): number | null => {
  if (param.isTuple()) {
    return canonicalTupleEnd(bytes, start, limit, param.components.length, index => param.components[index]);
  }
  if (param.isArray()) {
    const count = param.arrayLength === -1 ? smallWordAt(bytes, start) : param.arrayLength;
    if (count === null) return null;
    const head = start + (param.arrayLength === -1 ? 32 : 0);
    if (!isDynamic(param.arrayChildren)) {
      const end = head + count * headBytes(param.arrayChildren);
      return end <= limit ? end : null;
    }
    return canonicalTupleEnd(bytes, head, limit, count, () => param.arrayChildren);
  }
  if (param.baseType !== 'bytes' && param.baseType !== 'string') return null;
  const length = smallWordAt(bytes, start);
  if (length === null) return null;
  const end = start + 32 + Math.ceil(length / 32) * 32;
  return end <= limit ? end : null;
};

/** Reject inconsistent offset chains before allocating or decoding a claimed span. */
const canonicalCallAt = (bytes: Uint8Array, offset: number, call: DisputeCall): string | null => {
  const args = offset + 4;
  const lastOffset = smallWordAt(bytes, args + 32 * call.layout.lastSlot);
  if (lastOffset === null || lastOffset < call.layout.headBytes || lastOffset % 32 !== 0) return null;
  const lastLength = smallWordAt(bytes, args + lastOffset);
  if (lastLength === null) return null;
  const length = 4 + lastOffset + 32 + Math.ceil(lastLength / 32) * 32;
  if (length > MAX_EXECUTABLE_DISPUTE_CALL_BYTES || offset + length > bytes.length) return null;
  const inputs = call.fragment.inputs;
  if (canonicalTupleEnd(bytes, args, offset + length, inputs.length, index => inputs[index]) !== offset + length) {
    return null;
  }
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
 * A wrapper (Safe, ERC-4337, forwarder, packed MultiSend) can reuse a Depository
 * selector, so even offset zero must pass the same canonical check. With no
 * match the caller retains its strict decoder. Exact matches consume their
 * whole span: selector-shaped bytes inside an already decoded call are data.
 * A hit proves nothing about execution: callers accept a body only when it
 * matches the authenticated event exactly, proofbodyHash included, so a decoy
 * copy can never substitute a different body.
 */
export const extractEmbeddedDisputeCalls = (data: string): string[] => {
  const bytes = ethers.getBytes(data);
  const calls: string[] = [];
  for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
    const call = callAt(bytes, offset);
    const encoded = call ? canonicalCallAt(bytes, offset, call) : null;
    if (encoded) {
      calls.push(encoded);
      offset += ethers.dataLength(encoded) - 1;
    }
  }
  return calls;
};
