import type { Input as RlpInput } from '@ethereumjs/rlp';
import { ethers } from 'ethers';

export type CanonicalRpcLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: string | number;
  blockHash?: string;
  transactionHash?: string;
  transactionIndex?: string | number;
  logIndex?: string | number;
  index?: string | number;
};

export type AuthenticatedRpcLog = CanonicalRpcLog & {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  index: number;
  /** Ethereum receipt-trie membership. Absent for explicitly non-MPT chains. */
  receiptProof?: CanonicalReceiptMptProof;
};

export type CanonicalReceiptMptProof = {
  receiptsRoot: string;
  transactionIndex: number;
  encodedReceipt: string;
  proofNodes: string[];
  /** Index inside this receipt; `index` above is the block-global log index. */
  receiptLogIndex: number;
};

export type CanonicalRpcReceipt = {
  transactionHash?: string;
  transactionIndex: string | number;
  blockNumber?: string | number;
  blockHash?: string;
  type?: string | number;
  status?: string | number;
  root?: string;
  cumulativeGasUsed: string | number;
  logsBloom: string;
  logs: CanonicalRpcLog[];
  depositNonce?: string | number;
  depositReceiptVersion?: string | number;
};

export const parseReceiptHex = (value: unknown, label: string, bytes?: number): Uint8Array => {
  const normalized = String(value ?? '').trim();
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(normalized)) {
    throw new Error(`J_RECEIPT_${label}_HEX_INVALID`);
  }
  const result = ethers.getBytes(normalized);
  if (bytes !== undefined && result.length !== bytes) {
    throw new Error(`J_RECEIPT_${label}_LENGTH_INVALID:${result.length}`);
  }
  return result;
};

export const parseReceiptQuantity = (value: unknown, label: string): bigint => {
  try {
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      throw new Error('missing');
    }
    const parsed = typeof value === 'number'
      ? (Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : -1n)
      : BigInt(String(value));
    if (parsed < 0n) throw new Error('negative');
    return parsed;
  } catch {
    throw new Error(`J_RECEIPT_${label}_QUANTITY_INVALID:${String(value)}`);
  }
};

export const normalizeReceiptHash = (value: unknown, label: string): string =>
  ethers.hexlify(parseReceiptHex(value, label, 32)).toLowerCase();

const concatBytes = (...values: Uint8Array[]): Uint8Array => {
  const length = values.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
};

const encodeReceiptPayload = async (
  receipt: CanonicalRpcReceipt,
  type: bigint,
): Promise<Uint8Array> => {
  const { RLP } = await import('@ethereumjs/rlp');
  const outcome = receipt.status === undefined
    ? parseReceiptHex(receipt.root, 'STATE_ROOT', 32)
    : parseReceiptQuantity(receipt.status, 'STATUS');
  if (!Array.isArray(receipt.logs)) throw new Error('J_RECEIPT_LOGS_INVALID');
  const logs = receipt.logs.map((log, logIndex) => {
    if (!Array.isArray(log.topics)) throw new Error(`J_RECEIPT_LOG_TOPICS_INVALID:${logIndex}`);
    return [
      parseReceiptHex(log.address, `LOG_${logIndex}_ADDRESS`, 20),
      log.topics.map((topic, topicIndex) =>
        parseReceiptHex(topic, `LOG_${logIndex}_TOPIC_${topicIndex}`, 32)),
      parseReceiptHex(log.data, `LOG_${logIndex}_DATA`),
    ];
  });
  const fields: RlpInput[] = [
    outcome,
    parseReceiptQuantity(receipt.cumulativeGasUsed, 'CUMULATIVE_GAS'),
    parseReceiptHex(receipt.logsBloom, 'BLOOM', 256),
    logs,
  ];
  const hasDepositNonce = receipt.depositNonce !== undefined;
  const hasDepositVersion = receipt.depositReceiptVersion !== undefined;
  if (type === 0x7en) {
    if (hasDepositVersion && !hasDepositNonce) {
      throw new Error('J_RECEIPT_DEPOSIT_VERSION_WITHOUT_NONCE');
    }
    if (hasDepositNonce) fields.push(parseReceiptQuantity(receipt.depositNonce, 'DEPOSIT_NONCE'));
    if (hasDepositVersion) {
      const version = parseReceiptQuantity(receipt.depositReceiptVersion, 'DEPOSIT_VERSION');
      if (version !== 1n) throw new Error(`J_RECEIPT_DEPOSIT_VERSION_INVALID:${version}`);
      fields.push(version);
    }
  } else if (hasDepositNonce || hasDepositVersion) {
    throw new Error(`J_RECEIPT_DEPOSIT_FIELDS_ON_WRONG_TYPE:${type}`);
  }
  return RLP.encode(fields);
};

export const encodeCanonicalRpcReceipt = async (
  receipt: CanonicalRpcReceipt,
): Promise<Uint8Array> => {
  const type = receipt.type === undefined ? 0n : parseReceiptQuantity(receipt.type, 'TYPE');
  const payload = await encodeReceiptPayload(receipt, type);
  if (type === 0n) return payload;
  if (type > 0x7fn) throw new Error(`J_RECEIPT_TYPE_OUT_OF_RANGE:${type}`);
  return concatBytes(Uint8Array.of(Number(type)), payload);
};

export const computeCanonicalReceiptsRoot = async (
  receipts: readonly CanonicalRpcReceipt[],
): Promise<string> => {
  const [{ createMPT }, { RLP }] = await Promise.all([
    import('@ethereumjs/mpt'),
    import('@ethereumjs/rlp'),
  ]);
  const ordered = [...receipts].sort((left, right) =>
    Number(parseReceiptQuantity(left.transactionIndex, 'TRANSACTION_INDEX')) -
    Number(parseReceiptQuantity(right.transactionIndex, 'TRANSACTION_INDEX')));
  const trie = await createMPT();
  for (let index = 0; index < ordered.length; index += 1) {
    const receipt = ordered[index]!;
    const transactionIndex = parseReceiptQuantity(receipt.transactionIndex, 'TRANSACTION_INDEX');
    if (transactionIndex !== BigInt(index)) {
      throw new Error(`J_RECEIPT_TRANSACTION_INDEX_GAP:expected=${index}:actual=${transactionIndex}`);
    }
    await trie.put(RLP.encode(transactionIndex), await encodeCanonicalRpcReceipt(receipt));
  }
  return ethers.hexlify(trie.root()).toLowerCase();
};

export const createCanonicalReceiptProofs = async (
  receipts: readonly CanonicalRpcReceipt[],
  expectedRoot: string,
): Promise<Map<number, Omit<CanonicalReceiptMptProof, 'receiptLogIndex'>>> => {
  const [{ createMPT, createMerkleProof }, { RLP }] = await Promise.all([
    import('@ethereumjs/mpt'),
    import('@ethereumjs/rlp'),
  ]);
  const ordered = [...receipts].sort((left, right) =>
    Number(parseReceiptQuantity(left.transactionIndex, 'TRANSACTION_INDEX')) -
    Number(parseReceiptQuantity(right.transactionIndex, 'TRANSACTION_INDEX')));
  const trie = await createMPT();
  const encoded = new Map<number, Uint8Array>();
  for (let index = 0; index < ordered.length; index += 1) {
    const receipt = ordered[index]!;
    const transactionIndex = parseReceiptQuantity(receipt.transactionIndex, 'TRANSACTION_INDEX');
    if (transactionIndex !== BigInt(index)) {
      throw new Error(`J_RECEIPT_TRANSACTION_INDEX_GAP:expected=${index}:actual=${transactionIndex}`);
    }
    const receiptBytes = await encodeCanonicalRpcReceipt(receipt);
    encoded.set(index, receiptBytes);
    await trie.put(RLP.encode(transactionIndex), receiptBytes);
  }
  const receiptsRoot = ethers.hexlify(trie.root()).toLowerCase();
  const normalizedExpected = normalizeReceiptHash(expectedRoot, 'ROOT');
  if (receiptsRoot !== normalizedExpected) {
    throw new Error(`J_RECEIPT_ROOT_MISMATCH:expected=${normalizedExpected}:computed=${receiptsRoot}`);
  }
  const proofs = new Map<number, Omit<CanonicalReceiptMptProof, 'receiptLogIndex'>>();
  for (let index = 0; index < ordered.length; index += 1) {
    const key = RLP.encode(BigInt(index));
    const proofNodes = await createMerkleProof(trie, key);
    proofs.set(index, {
      receiptsRoot,
      transactionIndex: index,
      encodedReceipt: ethers.hexlify(encoded.get(index)!).toLowerCase(),
      proofNodes: proofNodes.map(node => ethers.hexlify(node).toLowerCase()),
    });
  }
  return proofs;
};

export const verifyCanonicalReceiptProof = async (
  proof: Omit<CanonicalReceiptMptProof, 'receiptLogIndex'>,
): Promise<void> => {
  if (!Number.isSafeInteger(proof.transactionIndex) || proof.transactionIndex < 0) {
    throw new Error(`J_RECEIPT_PROOF_TRANSACTION_INDEX_INVALID:${proof.transactionIndex}`);
  }
  const [{ createMPT, verifyMPTWithMerkleProof }, { RLP }] = await Promise.all([
    import('@ethereumjs/mpt'),
    import('@ethereumjs/rlp'),
  ]);
  const root = parseReceiptHex(proof.receiptsRoot, 'PROOF_ROOT', 32);
  const key = RLP.encode(BigInt(proof.transactionIndex));
  const proofNodes = proof.proofNodes.map((node, index) =>
    parseReceiptHex(node, `PROOF_NODE_${index}`));
  if (proofNodes.length === 0) throw new Error('J_RECEIPT_PROOF_NODES_MISSING');
  const trie = await createMPT();
  const value = await verifyMPTWithMerkleProof(trie, root, key, proofNodes);
  const expectedValue = ethers.hexlify(parseReceiptHex(proof.encodedReceipt, 'PROOF_VALUE')).toLowerCase();
  const actualValue = value ? ethers.hexlify(value).toLowerCase() : '';
  if (actualValue !== expectedValue) {
    throw new Error(`J_RECEIPT_PROOF_VALUE_MISMATCH:expected=${expectedValue}:actual=${actualValue || 'missing'}`);
  }
};

export const assertCanonicalReceiptsRoot = async (
  receipts: readonly CanonicalRpcReceipt[],
  expectedRoot: string,
): Promise<void> => {
  const normalizedExpected = ethers.hexlify(parseReceiptHex(expectedRoot, 'ROOT', 32)).toLowerCase();
  const computed = await computeCanonicalReceiptsRoot(receipts);
  if (computed !== normalizedExpected) {
    throw new Error(`J_RECEIPT_ROOT_MISMATCH:expected=${normalizedExpected}:computed=${computed}`);
  }
};

/** Ethereum log bloom membership has false positives but never false negatives. */
export const bloomMayContain = (logsBloom: string, value: string): boolean => {
  const bloom = parseReceiptHex(logsBloom, 'BLOOM', 256);
  const digest = ethers.getBytes(ethers.keccak256(parseReceiptHex(value, 'BLOOM_VALUE')));
  for (let offset = 0; offset < 6; offset += 2) {
    const bit = ((digest[offset]! << 8) | digest[offset + 1]!) & 2047;
    const byteIndex = bloom.length - 1 - Math.floor(bit / 8);
    if ((bloom[byteIndex]! & (1 << (bit % 8))) === 0) return false;
  }
  return true;
};
