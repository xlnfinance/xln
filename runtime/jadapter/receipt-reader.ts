import { ethers } from 'ethers';
import {
  assertCanonicalReceiptsRoot,
  bloomMayContain,
  createCanonicalReceiptProofs,
  encodeCanonicalRpcReceipt,
  normalizeReceiptHash,
  parseReceiptHex,
  parseReceiptQuantity,
  type AuthenticatedRpcLog,
  type CanonicalRpcLog,
  type CanonicalRpcReceipt,
  type CanonicalReceiptMptProof,
} from './receipt-codec';

type CanonicalRpcBlock = {
  number: string | number;
  hash: string;
  parentHash: string;
  receiptsRoot: string;
  logsBloom: string;
  transactions: string[];
};

type RpcSend = (method: string, params: unknown[]) => Promise<unknown>;

export type ReceiptReadProfile = {
  commitment?: 'ethereum-trie' | 'tron-complete-receipts';
  expectedParent?: {
    height: number;
    hash: string;
    finalized: boolean;
  };
};

export type AuthenticatedReceiptRange = {
  anchor: { jHeight: number; jBlockHash: string; parentHash: string };
  headers: Array<{ jHeight: number; jBlockHash: string; parentHash: string }>;
  logs: AuthenticatedRpcLog[];
};

const ZERO_HASH = `0x${'00'.repeat(32)}`;

const mapConcurrent = async <T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
};

const readCanonicalBlock = async (send: RpcSend, height: number): Promise<CanonicalRpcBlock> => {
  const raw = await send('eth_getBlockByNumber', [ethers.toQuantity(height), false]);
  if (!raw || typeof raw !== 'object') throw new Error(`J_RECEIPT_BLOCK_MISSING:${height}`);
  const block = raw as Partial<CanonicalRpcBlock>;
  if (parseReceiptQuantity(block.number, 'BLOCK_NUMBER') !== BigInt(height)) {
    throw new Error(`J_RECEIPT_BLOCK_NUMBER_MISMATCH:${height}:${String(block.number)}`);
  }
  normalizeReceiptHash(block.hash, 'BLOCK_HASH');
  normalizeReceiptHash(block.parentHash, 'PARENT_HASH');
  normalizeReceiptHash(block.receiptsRoot, 'ROOT');
  parseReceiptHex(block.logsBloom, 'BLOOM', 256);
  if (!Array.isArray(block.transactions) || block.transactions.some((hash) => typeof hash !== 'string')) {
    throw new Error(`J_RECEIPT_BLOCK_TRANSACTIONS_INVALID:${height}`);
  }
  return block as CanonicalRpcBlock;
};

const canonicalHeader = (block: CanonicalRpcBlock) => ({
  jHeight: Number(parseReceiptQuantity(block.number, 'BLOCK_NUMBER')),
  jBlockHash: normalizeReceiptHash(block.hash, 'BLOCK_HASH'),
  parentHash: normalizeReceiptHash(block.parentHash, 'PARENT_HASH'),
});

const assertContiguousBlocks = (
  blocks: readonly CanonicalRpcBlock[],
  expectedParent: ReceiptReadProfile['expectedParent'],
): void => {
  for (let index = 1; index < blocks.length; index += 1) {
    const parent = canonicalHeader(blocks[index - 1]!);
    const child = canonicalHeader(blocks[index]!);
    if (child.jHeight !== parent.jHeight + 1 || child.parentHash !== parent.jBlockHash) {
      throw new Error(
        `J_RECEIPT_RANGE_PARENT_MISMATCH:height=${child.jHeight}:` +
        `expected=${parent.jBlockHash}:actual=${child.parentHash}`,
      );
    }
  }
  if (!expectedParent) return;
  const anchor = canonicalHeader(blocks[0]!);
  const expectedHash = normalizeReceiptHash(expectedParent.hash, 'EXPECTED_PARENT_HASH');
  if (anchor.jHeight !== expectedParent.height || anchor.jBlockHash !== expectedHash) {
    const code = expectedParent.finalized
      ? 'J_RECEIPT_FINALIZED_PARENT_REORG'
      : 'J_RECEIPT_RANGE_REORG';
    throw new Error(
      `${code}:height=${expectedParent.height}:expected=${expectedHash}:actual=${anchor.jBlockHash}`,
    );
  }
};

const assertRangeFenceUnchanged = (
  before: readonly CanonicalRpcBlock[],
  after: readonly CanonicalRpcBlock[],
): void => {
  if (before.length !== after.length) throw new Error('J_RECEIPT_RANGE_REORG:LENGTH');
  for (let index = 0; index < before.length; index += 1) {
    const expected = canonicalHeader(before[index]!);
    const actual = canonicalHeader(after[index]!);
    if (
      expected.jHeight !== actual.jHeight ||
      expected.jBlockHash !== actual.jBlockHash ||
      expected.parentHash !== actual.parentHash
    ) {
      throw new Error(
        `J_RECEIPT_RANGE_REORG:height=${expected.jHeight}:` +
        `expected=${expected.jBlockHash}:${expected.parentHash}:` +
        `actual=${actual.jBlockHash}:${actual.parentHash}`,
      );
    }
  }
};

const validateReceiptSet = async (
  block: CanonicalRpcBlock,
  unorderedReceipts: readonly CanonicalRpcReceipt[],
): Promise<CanonicalRpcReceipt[]> => {
  if (unorderedReceipts.length !== block.transactions.length) {
    throw new Error(
      `J_RECEIPT_COUNT_MISMATCH:expected=${block.transactions.length}:actual=${unorderedReceipts.length}`,
    );
  }
  const receipts = [...unorderedReceipts].sort((left, right) =>
    Number(parseReceiptQuantity(left.transactionIndex, 'TRANSACTION_INDEX')) -
    Number(parseReceiptQuantity(right.transactionIndex, 'TRANSACTION_INDEX')));
  const blockHash = normalizeReceiptHash(block.hash, 'BLOCK_HASH');
  const blockNumber = parseReceiptQuantity(block.number, 'BLOCK_NUMBER');
  await Promise.all(receipts.map(async (receipt, index) => {
    const transactionHash = normalizeReceiptHash(block.transactions[index], `TRANSACTION_${index}_HASH`);
    if (parseReceiptQuantity(receipt.transactionIndex, 'TRANSACTION_INDEX') !== BigInt(index)) {
      throw new Error(`J_RECEIPT_TRANSACTION_INDEX_MISMATCH:${transactionHash}`);
    }
    if (normalizeReceiptHash(receipt.transactionHash, 'RECEIPT_TRANSACTION_HASH') !== transactionHash) {
      throw new Error(`J_RECEIPT_TRANSACTION_HASH_MISMATCH:${transactionHash}`);
    }
    if (normalizeReceiptHash(receipt.blockHash, 'RECEIPT_BLOCK_HASH') !== blockHash) {
      throw new Error(`J_RECEIPT_BLOCK_HASH_MISMATCH:${transactionHash}`);
    }
    if (parseReceiptQuantity(receipt.blockNumber, 'RECEIPT_BLOCK_NUMBER') !== blockNumber) {
      throw new Error(`J_RECEIPT_BLOCK_NUMBER_MISMATCH:${transactionHash}`);
    }
    if (!Array.isArray(receipt.logs)) throw new Error(`J_RECEIPT_LOGS_INVALID:${transactionHash}`);
    for (let logIndex = 0; logIndex < receipt.logs.length; logIndex += 1) {
      const log = receipt.logs[logIndex]!;
      if (normalizeReceiptHash(log.blockHash, 'LOG_BLOCK_HASH') !== blockHash) {
        throw new Error(`J_RECEIPT_LOG_BLOCK_HASH_MISMATCH:${transactionHash}:${logIndex}`);
      }
      if (parseReceiptQuantity(log.blockNumber, 'LOG_BLOCK_NUMBER') !== blockNumber) {
        throw new Error(`J_RECEIPT_LOG_BLOCK_NUMBER_MISMATCH:${transactionHash}:${logIndex}`);
      }
      if (normalizeReceiptHash(log.transactionHash, 'LOG_TRANSACTION_HASH') !== transactionHash) {
        throw new Error(`J_RECEIPT_LOG_TRANSACTION_HASH_MISMATCH:${transactionHash}:${logIndex}`);
      }
      if (parseReceiptQuantity(log.transactionIndex, 'LOG_TRANSACTION_INDEX') !== BigInt(index)) {
        throw new Error(`J_RECEIPT_LOG_TRANSACTION_INDEX_MISMATCH:${transactionHash}:${logIndex}`);
      }
    }
    await encodeCanonicalRpcReceipt(receipt);
  }));
  return receipts;
};

const readEthereumReceipts = async (
  send: RpcSend,
  block: CanonicalRpcBlock,
): Promise<{
  receipts: CanonicalRpcReceipt[];
  proofs: Map<number, Omit<CanonicalReceiptMptProof, 'receiptLogIndex'>>;
}> => {
  const unordered = await mapConcurrent(block.transactions, 16, async (transactionHash, index) => {
    const normalized = normalizeReceiptHash(transactionHash, `TRANSACTION_${index}_HASH`);
    const raw = await send('eth_getTransactionReceipt', [normalized]);
    if (!raw || typeof raw !== 'object') {
      throw new Error(`J_RECEIPT_TRANSACTION_RECEIPT_MISSING:${normalized}`);
    }
    return raw as CanonicalRpcReceipt;
  });
  const receipts = await validateReceiptSet(block, unordered);
  const proofs = await createCanonicalReceiptProofs(receipts, block.receiptsRoot);
  return { receipts, proofs };
};

const readTronReceipts = async (
  send: RpcSend,
  block: CanonicalRpcBlock,
): Promise<CanonicalRpcReceipt[]> => {
  const raw = await send('eth_getBlockReceipts', [
    ethers.toQuantity(parseReceiptQuantity(block.number, 'BLOCK_NUMBER')),
  ]);
  if (!Array.isArray(raw)) throw new Error('J_RECEIPT_BLOCK_RECEIPTS_INVALID');
  const receipts = await validateReceiptSet(block, raw as CanonicalRpcReceipt[]);
  const root = normalizeReceiptHash(block.receiptsRoot, 'ROOT');
  if (root !== ZERO_HASH) await assertCanonicalReceiptsRoot(receipts, root);
  return receipts;
};

const canonicalLogKey = (log: CanonicalRpcLog): string => {
  if (!Array.isArray(log.topics)) throw new Error('J_RECEIPT_LOG_TOPICS_INVALID');
  const topics = log.topics.map((topic, index) =>
    normalizeReceiptHash(topic, `CROSSCHECK_TOPIC_${index}`)).join(',');
  return [
    ethers.getAddress(log.address).toLowerCase(),
    topics,
    ethers.hexlify(parseReceiptHex(log.data, 'CROSSCHECK_DATA')).toLowerCase(),
    parseReceiptQuantity(log.blockNumber, 'CROSSCHECK_BLOCK_NUMBER').toString(),
    normalizeReceiptHash(log.blockHash, 'CROSSCHECK_BLOCK_HASH'),
    normalizeReceiptHash(log.transactionHash, 'CROSSCHECK_TRANSACTION_HASH'),
    parseReceiptQuantity(log.transactionIndex, 'CROSSCHECK_TRANSACTION_INDEX').toString(),
    parseReceiptQuantity(log.logIndex ?? log.index, 'CROSSCHECK_LOG_INDEX').toString(),
  ].join('|');
};

const logSetDigest = (keys: readonly string[]): string =>
  ethers.keccak256(ethers.toUtf8Bytes([...keys].sort().join('\n')));

const crossCheckTronLogs = async (
  send: RpcSend,
  fromBlock: number,
  toBlock: number,
  addresses: ReadonlySet<string>,
  expected: readonly AuthenticatedRpcLog[],
): Promise<void> => {
  const raw = await send('eth_getLogs', [{
    fromBlock: ethers.toQuantity(fromBlock),
    toBlock: ethers.toQuantity(toBlock),
    address: [...addresses],
  }]);
  if (!Array.isArray(raw)) throw new Error('J_RECEIPT_TRON_LOGS_INVALID');
  const actual = raw.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`J_RECEIPT_TRON_LOG_INVALID:${index}`);
    const log = value as CanonicalRpcLog & { removed?: boolean };
    if (log.removed === true) throw new Error(`J_RECEIPT_TRON_REMOVED_LOG:${index}`);
    if (!addresses.has(ethers.getAddress(log.address).toLowerCase())) {
      throw new Error(`J_RECEIPT_TRON_UNWATCHED_LOG:${index}`);
    }
    return canonicalLogKey(log);
  }).sort();
  const authenticated = expected.map(canonicalLogKey).sort();
  if (actual.length !== authenticated.length || actual.some((key, index) => key !== authenticated[index])) {
    throw new Error(
      `J_RECEIPT_TRON_LOG_CROSSCHECK_MISMATCH:` +
      `expected=${authenticated.length}:${logSetDigest(authenticated)}:` +
      `actual=${actual.length}:${logSetDigest(actual)}`,
    );
  }
};

const collectWatchedLogs = (
  block: CanonicalRpcBlock,
  receipts: readonly CanonicalRpcReceipt[],
  addresses: ReadonlySet<string>,
  proofs?: ReadonlyMap<number, Omit<CanonicalReceiptMptProof, 'receiptLogIndex'>>,
): AuthenticatedRpcLog[] => {
  const blockNumber = Number(parseReceiptQuantity(block.number, 'BLOCK_NUMBER'));
  const blockHash = normalizeReceiptHash(block.hash, 'BLOCK_HASH');
  const authenticated: AuthenticatedRpcLog[] = [];
  let logIndex = 0;
  for (const receipt of receipts) {
    const transactionHash = normalizeReceiptHash(receipt.transactionHash, 'RECEIPT_TRANSACTION_HASH');
    const transactionIndex = Number(parseReceiptQuantity(receipt.transactionIndex, 'TRANSACTION_INDEX'));
    for (let receiptLogIndex = 0; receiptLogIndex < receipt.logs.length; receiptLogIndex += 1) {
      const log = receipt.logs[receiptLogIndex]!;
      const canonicalLogIndex = logIndex;
      logIndex += 1;
      if (!addresses.has(ethers.getAddress(log.address).toLowerCase())) continue;
      const receiptProof = proofs?.get(transactionIndex);
      if (proofs && !receiptProof) {
        throw new Error(`J_RECEIPT_PROOF_MISSING:${blockNumber}:${transactionIndex}`);
      }
      authenticated.push({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
        blockNumber,
        blockHash,
        transactionHash,
        transactionIndex,
        logIndex: canonicalLogIndex,
        index: canonicalLogIndex,
        ...(receiptProof ? {
          receiptProof: {
            ...receiptProof,
            receiptLogIndex,
          },
        } : {}),
      });
    }
  }
  return authenticated;
};

/**
 * Ethereum receipts are authenticated by the block header. TRON's JSON-RPC
 * currently exposes zero receipt roots/blooms, so its explicit profile instead
 * requires a complete ordered receipt set and an exact independent getLogs
 * response. Neither profile may silently fall back or advance on disagreement.
 */
export const readAuthenticatedReceiptRange = async (
  send: RpcSend,
  fromBlock: number,
  toBlock: number,
  watchedAddresses: readonly string[],
  profile: ReceiptReadProfile = {},
): Promise<AuthenticatedReceiptRange> => {
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 1 || toBlock < fromBlock) {
    throw new Error(`J_RECEIPT_RANGE_INVALID:${fromBlock}:${toBlock}`);
  }
  const addresses = new Set(watchedAddresses.map((address) => ethers.getAddress(address).toLowerCase()));
  if (addresses.size === 0) throw new Error('J_RECEIPT_WATCH_ADDRESS_EMPTY');
  if (addresses.size !== watchedAddresses.length) throw new Error('J_RECEIPT_WATCH_ADDRESS_DUPLICATE');
  const commitment = profile.commitment ?? 'ethereum-trie';
  const anchorHeight = fromBlock > 1 ? fromBlock - 1 : fromBlock;
  const rangeHeights = Array.from({ length: toBlock - anchorHeight + 1 }, (_, index) => anchorHeight + index);
  const rangeBlocks = await mapConcurrent(rangeHeights, 16, (height) => readCanonicalBlock(send, height));
  assertContiguousBlocks(rangeBlocks, profile.expectedParent);
  const blocks = rangeBlocks.filter(block => Number(parseReceiptQuantity(block.number, 'BLOCK_NUMBER')) >= fromBlock);
  const logsByBlock = await mapConcurrent(blocks, 4, async (block) => {
    if (commitment === 'ethereum-trie' &&
      ![...addresses].some((address) => bloomMayContain(block.logsBloom, address))) return [];
    if (commitment === 'tron-complete-receipts') {
      return collectWatchedLogs(block, await readTronReceipts(send, block), addresses);
    }
    const authenticated = await readEthereumReceipts(send, block);
    return collectWatchedLogs(block, authenticated.receipts, addresses, authenticated.proofs);
  });
  const logs = logsByBlock.flat().sort((left, right) =>
    left.blockNumber - right.blockNumber || left.index - right.index);
  if (commitment === 'tron-complete-receipts') {
    await crossCheckTronLogs(send, fromBlock, toBlock, addresses, logs);
  }
  const fenceBlocks = await mapConcurrent(rangeHeights, 16, (height) => readCanonicalBlock(send, height));
  assertContiguousBlocks(fenceBlocks, profile.expectedParent);
  assertRangeFenceUnchanged(rangeBlocks, fenceBlocks);
  return {
    anchor: canonicalHeader(rangeBlocks[0]!),
    headers: blocks.map(canonicalHeader),
    logs,
  };
};

export const readAuthenticatedLogsForRange = async (
  send: RpcSend,
  fromBlock: number,
  toBlock: number,
  watchedAddresses: readonly string[],
  profile: ReceiptReadProfile = {},
): Promise<AuthenticatedRpcLog[]> => (
  await readAuthenticatedReceiptRange(send, fromBlock, toBlock, watchedAddresses, profile)
).logs;
