import { ethers } from 'ethers';

import type { DebtEntry } from '../../../../types/finance/debt';
import {
  createCanonicalReceiptProofs,
  verifyCanonicalReceiptProof,
  type CanonicalRpcReceipt,
} from '../../../machine/receipt-codec';
import { sendBatchInChunks, type RpcBatchSend } from '../../rpc-utils';
import { readHashBoundHeaderRoots, readHashBoundStateRoot } from './rpc-header-hash';
import { verifyGetProofResponse, type GetProofResponse } from './rpc-state-proof';

// Authenticates where an open DebtEntry was created, under one hash-bound
// header: createdTxHash is keccak of the raw transaction at index i of the
// header's transactionsRoot, and receipt i of the header's receiptsRoot holds
// the Depository DebtCreated log for exactly this debtor, creditor, token,
// amount, index and debtSeq. Every RPC answer is checked against a root; a
// claimed field is never taken on its own.

type RpcSend = (method: string, params: unknown[]) => Promise<unknown>;

const DEBT_CREATED_TOPIC = ethers.id('DebtCreated(bytes32,bytes32,uint256,(uint256,uint256),uint256,uint256)').toLowerCase();

const fail = (code: string, detail = ''): never => {
  throw new Error(`DEBT_PROVENANCE_${code}${detail ? `:${detail}` : ''}`);
};

const rawHex = (value: unknown, field: string): string => {
  const text = String(value ?? '').toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})+$/.test(text)) fail('FIELD_INVALID', field);
  return text;
};

const word = (value: bigint): string => ethers.zeroPadValue(ethers.toBeHex(value), 32).toLowerCase();

/** Returns the index of txHash inside the block, proven by transactionsRoot. */
const proveTransactionIndex = async (
  send: RpcSend,
  sendBatch: RpcBatchSend | undefined,
  blockHash: string,
  transactionsRoot: string,
  txHash: string,
): Promise<number> => {
  const [{ createMPT }, { RLP }] = await Promise.all([import('@ethereumjs/mpt'), import('@ethereumjs/rlp')]);
  const countText = String(await send('eth_getBlockTransactionCountByHash', [blockHash]) ?? '').toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(countText)) fail('FIELD_INVALID', 'transactionCount');
  const count = Number(BigInt(countText));
  if (!Number.isSafeInteger(count) || count <= 0) fail('BLOCK_EMPTY', blockHash);
  const calls = Array.from({ length: count }, (_, index) => ({
    method: 'eth_getRawTransactionByBlockHashAndIndex',
    params: [blockHash, ethers.toQuantity(index)],
  }));
  // A mainnet block holds hundreds of transactions: one batch per 128 instead
  // of one round trip each. Answers come back in input order and every one is
  // still a leaf of the transactionsRoot checked below.
  let raws: unknown[] = [];
  if (sendBatch) raws = await sendBatchInChunks(sendBatch, calls, 4);
  else for (const call of calls) raws.push(await send(call.method, call.params));
  if (raws.length !== count) fail('FIELD_INVALID', `rawTransactions:${raws.length}:${count}`);
  const trie = await createMPT();
  let found = -1;
  for (let index = 0; index < count; index += 1) {
    const raw = rawHex(raws[index], `rawTransaction:${index}`);
    if (ethers.keccak256(raw).toLowerCase() === txHash) {
      if (found !== -1) fail('TRANSACTION_DUPLICATE', txHash);
      found = index;
    }
    await trie.put(RLP.encode(index), ethers.getBytes(raw));
  }
  const computed = ethers.hexlify(trie.root()).toLowerCase();
  if (computed !== transactionsRoot) fail('TRANSACTIONS_ROOT_MISMATCH', `${transactionsRoot}:${computed}`);
  if (found === -1) fail('TRANSACTION_NOT_IN_BLOCK', txHash);
  return found;
};

type ReceiptLog = { address: string; topics: string[]; data: string };

const decodeReceiptLogs = (encodedReceipt: string): { status: string; logs: ReceiptLog[] } => {
  const bytes = ethers.getBytes(encodedReceipt);
  const body = (bytes[0] ?? 0xff) < 0x80 ? bytes.slice(1) : bytes;
  const decoded = ethers.decodeRlp(body);
  if (!Array.isArray(decoded) || decoded.length !== 4 || !Array.isArray(decoded[3])) fail('RECEIPT_SHAPE');
  const fields = decoded as [string, string, string, unknown[]];
  const logs = fields[3].map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 3 || !Array.isArray(entry[1])) fail('RECEIPT_LOG_SHAPE', String(index));
    const [address, topics, data] = entry as [string, string[], string];
    return { address: address.toLowerCase(), topics: topics.map(topic => topic.toLowerCase()), data: data.toLowerCase() };
  });
  return { status: fields[0].toLowerCase(), logs };
};

export type DebtProvenanceClaim = {
  send: RpcSend;
  /** Batched transport for the per-transaction reads; sequential `send` without it. */
  sendBatch?: RpcBatchSend;
  depository: string;
  /** Block hash already authenticated by the caller's canonical header chain. */
  authenticatedBlockHash: string;
  entry: DebtEntry;
};

/** Fails closed unless entry.createdTxHash created exactly this debt in that block. */
export const assertDebtCreationProvenance = async (claim: DebtProvenanceClaim): Promise<number> => {
  const { send, entry } = claim;
  const depository = claim.depository.toLowerCase();
  const blockHash = claim.authenticatedBlockHash.toLowerCase();
  const txHash = entry.createdTxHash.toLowerCase();
  const roots = await readHashBoundHeaderRoots(send, entry.createdAtBlock, blockHash);
  const transactionIndex = await proveTransactionIndex(send, claim.sendBatch, blockHash, roots.transactionsRoot, txHash);
  const receipts = await send('eth_getBlockReceipts', [ethers.toQuantity(entry.createdAtBlock)]);
  if (!Array.isArray(receipts)) return fail('RECEIPTS_MISSING', String(entry.createdAtBlock));
  const proofs = await createCanonicalReceiptProofs(receipts as CanonicalRpcReceipt[], roots.receiptsRoot);
  const proof = proofs.get(transactionIndex);
  if (!proof) return fail('RECEIPT_MISSING', `${txHash}:${transactionIndex}`);
  await verifyCanonicalReceiptProof(proof);
  const receipt = decodeReceiptLogs(proof.encodedReceipt);
  if (receipt.status !== '0x01') fail('RECEIPT_REVERTED', txHash);
  const created = receipt.logs.filter(log =>
    log.address === depository && log.topics[0] === DEBT_CREATED_TOPIC && log.topics.length === 4 && log.data.length === 2 + 4 * 64);
  const seqWord = word(entry.createdSeq).slice(2);
  const match = created.filter(log => log.data.slice(2 + 3 * 64) === seqWord);
  const log = match.length === 1 ? match[0] : undefined;
  if (!log) return fail('LOG_MISSING', `${txHash}:seq=${entry.createdSeq}:found=${match.length}`);
  const amount = (BigInt(`0x${log.data.slice(2, 66)}`) << 256n) | BigInt(`0x${log.data.slice(66, 130)}`);
  const debtIndex = BigInt(`0x${log.data.slice(130, 194)}`);
  const expected = [word(BigInt(entry.debtor)), word(BigInt(entry.creditor)), word(BigInt(entry.tokenId))];
  if (
    log.topics[1] !== expected[0] || log.topics[2] !== expected[1] || log.topics[3] !== expected[2] ||
    amount !== entry.createdAmount || debtIndex !== BigInt(entry.createdDebtIndex)
  ) {
    fail('LOG_MISMATCH', `${txHash}:seq=${entry.createdSeq}`);
  }
  return transactionIndex;
};

// EIP-2935: each block's state holds the previous 8191 block hashes in the
// system history contract at slot number % 8191. The code hash is pinned to
// the canonical EIP bytecode so another contract at that address cannot serve.
export const HISTORY_STORAGE_ADDRESS = '0x0000F90827F1C53a10cb7A02335B175320002935';
export const HISTORY_SERVE_WINDOW = 8191;
const HISTORY_CODE_HASH = ethers.keccak256(
  '0x3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500',
).toLowerCase();

/** Fails closed unless the anchor's hash-bound state records blockHash at blockNumber. */
export const assertBlockHashInAnchorHistory = async (
  send: RpcSend,
  anchor: { blockNumber: number; blockHash: string },
  blockNumber: number,
  blockHash: string,
): Promise<void> => {
  if (!(blockNumber < anchor.blockNumber)) fail('HISTORY_NOT_BEFORE_ANCHOR', `${blockNumber}:${anchor.blockNumber}`);
  if (anchor.blockNumber - blockNumber > HISTORY_SERVE_WINDOW) fail('HISTORY_OUT_OF_WINDOW', `${blockNumber}:${anchor.blockNumber}`);
  const stateRoot = await readHashBoundStateRoot(send, anchor.blockNumber, anchor.blockHash);
  const slot = BigInt(blockNumber % HISTORY_SERVE_WINDOW);
  const response = (await send('eth_getProof', [
    HISTORY_STORAGE_ADDRESS, [ethers.toBeHex(slot, 32)], ethers.toQuantity(anchor.blockNumber),
  ])) as GetProofResponse;
  const proven = verifyGetProofResponse(stateRoot, HISTORY_STORAGE_ADDRESS, [slot], response);
  if (proven.account?.codeHash.toLowerCase() !== HISTORY_CODE_HASH) fail('HISTORY_CONTRACT_MISSING', HISTORY_STORAGE_ADDRESS);
  const recorded = proven.storage.get(slot);
  if (recorded === undefined) return fail('HISTORY_SLOT_MISSING', String(slot));
  if (word(recorded) !== blockHash.toLowerCase()) fail('HISTORY_HASH_MISMATCH', `${blockNumber}:${blockHash}:${word(recorded)}`);
};
