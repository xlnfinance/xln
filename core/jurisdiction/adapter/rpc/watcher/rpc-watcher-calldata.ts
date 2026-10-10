import { ethers } from 'ethers';
import { Depository__factory } from '../../../../../jurisdictions/typechain-types';
import { decodeIncludedTronTransactionCall } from '../../operations/tron-transaction';

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
const DISPUTE_CALLS = [requireFunction('processBatch'), requireFunction('watchtowerCounterDispute')]
  .map(fragment => ({ fragment, selector: ethers.getBytes(fragment.selector) }));

/** Selector hits decoded per transaction; a decoy flood cannot cost more. */
const DISPUTE_CALLDATA_SCAN_MAX_HITS = 64;

const callAt = (bytes: Uint8Array, offset: number): ethers.FunctionFragment | undefined =>
  DISPUTE_CALLS.find(call => call.selector.every((byte, index) => bytes[offset + index] === byte))?.fragment;

/** The canonical ABI call starting at `offset`, or null when those bytes only resemble one. */
const canonicalCallAt = (bytes: Uint8Array, offset: number, fragment: ethers.FunctionFragment): string | null => {
  const tail = ethers.hexlify(bytes.subarray(offset));
  let encoded: string;
  try {
    encoded = depositoryInterface.encodeFunctionData(
      fragment,
      depositoryInterface.decodeFunctionData(fragment, tail),
    );
  } catch {
    // A selector-shaped byte run inside foreign calldata is not a call.
    return null;
  }
  return tail.startsWith(encoded) ? encoded : null;
};

/**
 * Exact Depository dispute calls embedded in wrapper calldata.
 *
 * Returns null for a direct processBatch/watchtowerCounterDispute call, which
 * keeps its strict decoder. A wrapper (Safe, ERC-4337, forwarder, packed
 * MultiSend) places the call at any byte offset, so every selector hit is
 * decoded and kept only when its canonical re-encoding is a byte prefix there.
 * A hit proves nothing about execution: callers accept a body only when it
 * matches the authenticated event exactly, proofbodyHash included, so a decoy
 * copy can never substitute a different body.
 */
export const extractEmbeddedDisputeCalls = (data: string): string[] | null => {
  const bytes = ethers.getBytes(data);
  if (bytes.length >= 4 && callAt(bytes, 0)) return null;
  const calls: string[] = [];
  let hits = 0;
  for (let offset = 1; offset + 4 <= bytes.length && hits < DISPUTE_CALLDATA_SCAN_MAX_HITS; offset += 1) {
    const fragment = callAt(bytes, offset);
    if (!fragment) continue;
    hits += 1;
    const encoded = canonicalCallAt(bytes, offset, fragment);
    if (encoded) calls.push(encoded);
  }
  return calls;
};
