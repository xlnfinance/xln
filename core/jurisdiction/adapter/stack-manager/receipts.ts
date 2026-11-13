import { JsonRpcProvider, type TransactionReceipt } from 'ethers';
import { setTimeout } from 'node:timers/promises';
import type { JurisdictionStackManifest } from './types';

export type CanonicalChainPoint = Readonly<{ number: number; hash: string }>;

export const readCanonicalChainPoint = async (provider: JsonRpcProvider): Promise<CanonicalChainPoint> => {
  const value: unknown = await provider.send('eth_getBlockByNumber', ['latest', false]);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('STACK_MANAGER_CHAIN_TIP_INVALID');
  const block = value as Record<string, unknown>;
  if (typeof block['number'] !== 'string' || !/^0x[0-9a-f]+$/i.test(block['number'])
    || !Number.isSafeInteger(Number(BigInt(block['number']))) || typeof block['hash'] !== 'string'
    || !/^0x[0-9a-f]{64}$/i.test(block['hash'])) throw new Error('STACK_MANAGER_CHAIN_TIP_INVALID');
  return { number: Number(BigInt(block['number'])), hash: block['hash'] };
};

export const assertCanonicalChainPoint = async (provider: JsonRpcProvider, point: CanonicalChainPoint): Promise<void> => {
  const value: unknown = await provider.send('eth_getBlockByNumber', [`0x${point.number.toString(16)}`, false]);
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>)['hash'] !== point.hash) {
    throw new Error(`STACK_MANAGER_CANONICAL_SNAPSHOT_CONFLICT:${point.number}:${point.hash}`);
  }
};

const readCanonicalReceipt = async (provider: JsonRpcProvider, hash: string) => {
  const value: unknown = await provider.send('eth_getTransactionReceipt', [hash]);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`STACK_MANAGER_RECEIPT_INVALID:${hash}`);
  const raw = value as Record<string, unknown>;
  const blockNumber = raw['blockNumber'];
  const blockHash = raw['blockHash'];
  if (raw['transactionHash'] !== hash || raw['status'] !== '0x1' || typeof blockNumber !== 'string'
    || !/^0x[0-9a-f]+$/i.test(blockNumber) || typeof blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(blockHash)) {
    throw new Error(`STACK_MANAGER_RECEIPT_INVALID:${hash}`);
  }
  const [tip, block] = await Promise.all([
    provider.send('eth_blockNumber', []) as Promise<unknown>,
    provider.send('eth_getBlockByNumber', [blockNumber, false]) as Promise<unknown>,
  ]);
  if (typeof tip !== 'string' || !/^0x[0-9a-f]+$/i.test(tip)) throw new Error('STACK_MANAGER_CHAIN_TIP_INVALID');
  if (!block || typeof block !== 'object' || (block as Record<string, unknown>)['hash'] !== blockHash) {
    throw new Error(`STACK_MANAGER_RECEIPT_CANONICAL_BLOCK_MISMATCH:${hash}`);
  }
  return { blockHash, blockNumber: BigInt(blockNumber), depth: BigInt(tip) - BigInt(blockNumber) + 1n };
};

export const readConfirmedReceipt = async (
  provider: JsonRpcProvider, hash: string, confirmations: number,
  validate: (receipt: TransactionReceipt | null) => TransactionReceipt,
  atBlock?: number,
): Promise<TransactionReceipt> => {
  // A tip can advance while the SDK awaits a receipt, before its block-listener
  // bootstrap. At a static confirmed tip that listener may then wait forever.
  // Read current canonical RPC evidence; a future block event is not required.
  while (true) {
    const receipt = validate(await provider.getTransactionReceipt(hash));
    const canonical = await readCanonicalReceipt(provider, hash);
    if (receipt.blockHash !== canonical.blockHash || BigInt(receipt.blockNumber) !== canonical.blockNumber) {
      throw new Error(`STACK_MANAGER_RECEIPT_CANONICAL_BLOCK_MISMATCH:${hash}`);
    }
    const depth = atBlock === undefined ? canonical.depth : BigInt(atBlock) - canonical.blockNumber + 1n;
    if (depth >= BigInt(confirmations)) return receipt;
    if (atBlock !== undefined) throw new Error(`STACK_MANAGER_CURRENT_RECEIPT_CONFLICT:${hash}`);
    await setTimeout(provider.pollingInterval);
  }
};

export const verifyCurrentStackReceipts = async (provider: JsonRpcProvider, manifest: JurisdictionStackManifest, confirmations: number, atBlock?: number): Promise<void> => {
  for (const operation of Object.values(manifest.evmContracts)) {
    const receipt = await readCanonicalReceipt(provider, operation.transactionHash);
    const blockNumber = 'deploymentBlock' in operation ? operation.deploymentBlock : operation.blockNumber;
    const depth = atBlock === undefined ? receipt.depth : BigInt(atBlock) - receipt.blockNumber + 1n;
    if (receipt.blockNumber !== BigInt(blockNumber) || depth < BigInt(confirmations)) {
      throw new Error(`STACK_MANAGER_CURRENT_RECEIPT_CONFLICT:${operation.transactionHash}`);
    }
  }
};
