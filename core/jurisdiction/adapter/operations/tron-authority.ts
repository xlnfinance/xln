import { ethers } from 'ethers';
import type { TronWeb } from 'tronweb';
import type { JAdapterConfig } from '../types';
import { decodeSignedTronTransaction } from './tron-transaction';

export type TronExpiryEvidence = {
  oldTransactionHash: string;
  blockNumber: number;
  blockHash: string;
  /** Native chain timestamp in milliseconds, not browser wall time. */
  timestamp: number;
};
type NativeHeader = { blockNumber: number; blockHash: string; timestamp: number };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TRON_AUTHORITY_RECORD_INVALID');
  return value as Record<string, unknown>;
};
export const parseNativeTronHeader = (value: unknown): NativeHeader => {
  const block = record(value);
  const header = record(record(block['block_header'])['raw_data']);
  const blockNumber = header['number'];
  const timestamp = header['timestamp'];
  const hash = block['blockID'];
  if (typeof blockNumber !== 'number' || !Number.isSafeInteger(blockNumber) || blockNumber < 1
    || typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp <= 0
    || typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)
    || BigInt(`0x${hash.slice(0, 16)}`) !== BigInt(blockNumber)) throw new Error('TRON_AUTHORITY_HEADER_INVALID');
  return { blockNumber, blockHash: `0x${hash.toLowerCase()}`, timestamp };
};
export const assertTronRpcHeaderBinding = (native: NativeHeader, value: unknown): void => {
  const rpc = record(value);
  if (rpc['hash'] !== native.blockHash || BigInt(String(rpc['number'])) !== BigInt(native.blockNumber)
    || BigInt(String(rpc['timestamp'])) !== BigInt(Math.floor(native.timestamp / 1000))) {
    throw new Error('TRON_NATIVE_RPC_HEADER_MISMATCH');
  }
};
const bindRpc = async (provider: ethers.JsonRpcProvider, header: NativeHeader): Promise<void> => {
  assertTronRpcHeaderBinding(header, await provider.send('eth_getBlockByNumber', [ethers.toQuantity(header.blockNumber), false]));
};
export const createNativeTronClient = async (config: JAdapterConfig): Promise<TronWeb> => {
  if (config.mode !== 'tron') throw new Error('TRON_NATIVE_POLICY_REQUIRED');
  const { TronWeb } = await import('tronweb');
  const fullHost = String(config.tronFullHost || config.rpcUrl).replace(/\/jsonrpc\/?$/i, '').replace(/\/$/, '');
  const apiKey = config.tronApiKey || process.env['TRONGRID_API_KEY'];
  return new TronWeb({ fullHost, ...(config.tronSolidityHost ? { solidityNode: config.tronSolidityHost } : {}),
    ...(apiKey ? { headers: { 'TRON-PRO-API-KEY': apiKey } } : {}) });
};

/** Bind the native TAPOS source to the already chain-verified configured JSON RPC. */
export const readBoundTronBlockHeader = async (client: TronWeb, provider: ethers.JsonRpcProvider) => {
  const header = parseNativeTronHeader(await client.trx.getCurrentBlock());
  await bindRpc(provider, header);
  return { ref_block_bytes: ethers.toBeHex(header.blockNumber, 8).slice(-4),
    ref_block_hash: header.blockHash.slice(18, 34), timestamp: header.timestamp, expiration: header.timestamp + 60_000 };
};

/** Explicit RPC attestation, not a cryptographic proof of historical absence.
 * A finalized timestamp beyond expiry prevents future execution of the old wire. */
export const readTronExpiryEvidence = async (
  client: TronWeb, provider: ethers.JsonRpcProvider, raw: string,
): Promise<TronExpiryEvidence | null> => {
  const transaction = decodeSignedTronTransaction(raw);
  const header = parseNativeTronHeader(await client.solidityNode.request('walletsolidity/getnowblock', {}, 'post'));
  const full = parseNativeTronHeader(await client.fullNode.request('wallet/getblockbynum', { num: header.blockNumber }, 'post'));
  if (full.blockHash !== header.blockHash || full.timestamp !== header.timestamp) throw new Error('TRON_SOLID_FULL_HEADER_MISMATCH');
  await bindRpc(provider, header);
  if (BigInt(header.timestamp) <= transaction.expiration) return null;
  const value = transaction.hash.slice(2);
  const [nativeReceipt, solidReceipt, rpcReceipt] = await Promise.all([
    client.fullNode.request('wallet/gettransactioninfobyid', { value }, 'post'),
    client.solidityNode.request('walletsolidity/gettransactioninfobyid', { value }, 'post'),
    provider.getTransactionReceipt(transaction.hash),
  ]);
  const native = record(nativeReceipt);
  const solid = record(solidReceipt);
  const exists = Object.keys(native).length > 0;
  if (exists !== (rpcReceipt !== null) || (Object.keys(solid).length > 0 && !exists)) {
    throw new Error('TRON_RECEIPT_INDEX_INCONSISTENT');
  }
  if (exists) {
    if (native['id'] !== value || rpcReceipt?.hash !== transaction.hash
      || (Object.keys(solid).length > 0 && solid['id'] !== value)) throw new Error('TRON_RECEIPT_ID_MISMATCH');
    const includedAt = native['blockNumber'];
    if (typeof includedAt !== 'number' || !Number.isSafeInteger(includedAt) || includedAt < 1
      || rpcReceipt.blockNumber !== includedAt
      || (includedAt <= header.blockNumber && Object.keys(solid).length === 0)) {
      throw new Error('TRON_RECEIPT_INDEX_INCONSISTENT');
    }
    return null;
  }
  return { ...header, oldTransactionHash: transaction.hash };
};
