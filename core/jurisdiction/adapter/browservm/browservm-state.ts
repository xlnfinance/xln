import { hexToBytes } from '@ethereumjs/util';

// Testnet has one canonical BrowserVM snapshot. Breaking changes replace v1;
// stale snapshots fail closed instead of entering a migration branch.
export const BROWSERVM_CONTRACT_VERSION = 1;

export type BrowserVmStoredReceipt = {
  transactionHash: string;
  /** Canonical transaction calldata required to reconstruct event sidecars. */
  data: string;
  blockNumber: number;
  blockHash: string;
  from: string;
  to: string | null;
  contractAddress: string | null;
  status: number;
  type: number;
  transactionIndex: number;
  cumulativeGasUsed: string;
  logsBloom: string;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    blockNumber: number;
    transactionHash: string;
    logIndex: number;
  }>;
};

export type BrowserVmChainCheckpoint = {
  blockHeight: number;
  blockHash: string;
  blockTimestamp: number;
  entityProviderDeploymentBlock: number;
  blockHashes: Array<[number, string]>;
  blockReceiptRoots: Array<[number, string]>;
  txReceipts: Array<[string, BrowserVmStoredReceipt]>;
};

export type BrowserVmSerializedState = {
  version: 1;
  chainId: number;
  stateRoot: string;
  trieData: Array<[string, string]>;
  nonce: string;
  entityProviderDeploymentBlock: number;
  chain: BrowserVmChainCheckpoint;
  addresses: {
    depository: string;
    entityProvider: string;
  };
};

const boundaryRecord = (value: unknown, code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};

const exactBoundaryKeys = (value: Record<string, unknown>, keys: readonly string[], code: string): void => {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(code);
  }
};

const boundaryString = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(code);
  return value;
};

const boundaryInteger = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
};

const decodeStoredLog = (value: unknown): BrowserVmStoredReceipt['logs'][number] => {
  const log = boundaryRecord(value, 'BROWSERVM_STORED_LOG_INVALID');
  exactBoundaryKeys(log, [
    'address', 'topics', 'data', 'blockNumber', 'transactionHash', 'logIndex',
  ], 'BROWSERVM_STORED_LOG_FIELDS_INVALID');
  if (!Array.isArray(log['topics']) || log['topics'].some(topic => typeof topic !== 'string')) {
    throw new Error('BROWSERVM_STORED_LOG_TOPICS_INVALID');
  }
  return {
    address: boundaryString(log['address'], 'BROWSERVM_STORED_LOG_ADDRESS_INVALID'),
    topics: [...log['topics']],
    data: boundaryString(log['data'], 'BROWSERVM_STORED_LOG_DATA_INVALID'),
    blockNumber: boundaryInteger(log['blockNumber'], 'BROWSERVM_STORED_LOG_BLOCK_INVALID'),
    transactionHash: boundaryString(log['transactionHash'], 'BROWSERVM_STORED_LOG_TX_INVALID'),
    logIndex: boundaryInteger(log['logIndex'], 'BROWSERVM_STORED_LOG_INDEX_INVALID'),
  };
};

const decodeStoredReceipt = (value: unknown): BrowserVmStoredReceipt => {
  const receipt = boundaryRecord(value, 'BROWSERVM_STORED_RECEIPT_INVALID');
  exactBoundaryKeys(receipt, [
    'transactionHash', 'data', 'blockNumber', 'blockHash', 'from', 'to', 'contractAddress',
    'status', 'type', 'transactionIndex', 'cumulativeGasUsed', 'logsBloom', 'logs',
  ], 'BROWSERVM_STORED_RECEIPT_FIELDS_INVALID');
  const nullableString = (field: 'to' | 'contractAddress'): string | null => {
    const valueAtField = receipt[field];
    if (valueAtField === null) return null;
    return boundaryString(valueAtField, `BROWSERVM_STORED_RECEIPT_${field.toUpperCase()}_INVALID`);
  };
  if (!Array.isArray(receipt['logs'])) throw new Error('BROWSERVM_STORED_RECEIPT_LOGS_INVALID');
  return {
    transactionHash: boundaryString(receipt['transactionHash'], 'BROWSERVM_STORED_RECEIPT_TX_INVALID'),
    data: boundaryString(receipt['data'], 'BROWSERVM_STORED_RECEIPT_DATA_INVALID'),
    blockNumber: boundaryInteger(receipt['blockNumber'], 'BROWSERVM_STORED_RECEIPT_BLOCK_INVALID'),
    blockHash: boundaryString(receipt['blockHash'], 'BROWSERVM_STORED_RECEIPT_HASH_INVALID'),
    from: boundaryString(receipt['from'], 'BROWSERVM_STORED_RECEIPT_FROM_INVALID'),
    to: nullableString('to'),
    contractAddress: nullableString('contractAddress'),
    status: boundaryInteger(receipt['status'], 'BROWSERVM_STORED_RECEIPT_STATUS_INVALID'),
    type: boundaryInteger(receipt['type'], 'BROWSERVM_STORED_RECEIPT_TYPE_INVALID'),
    transactionIndex: boundaryInteger(receipt['transactionIndex'], 'BROWSERVM_STORED_RECEIPT_INDEX_INVALID'),
    cumulativeGasUsed: boundaryString(receipt['cumulativeGasUsed'], 'BROWSERVM_STORED_RECEIPT_GAS_INVALID'),
    logsBloom: boundaryString(receipt['logsBloom'], 'BROWSERVM_STORED_RECEIPT_BLOOM_INVALID'),
    logs: receipt['logs'].map(decodeStoredLog),
  };
};

const decodeStringPairArray = (value: unknown, code: string): Array<[number, string]> => {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error(code);
    return [boundaryInteger(entry[0], code), boundaryString(entry[1], code)];
  });
};

const decodeBrowserVmChainCheckpoint = (value: unknown): BrowserVmChainCheckpoint => {
  const chain = boundaryRecord(value, 'BROWSERVM_CHECKPOINT_INVALID');
  exactBoundaryKeys(chain, [
    'blockHeight', 'blockHash', 'blockTimestamp', 'entityProviderDeploymentBlock',
    'blockHashes', 'blockReceiptRoots', 'txReceipts',
  ], 'BROWSERVM_CHECKPOINT_FIELDS_INVALID');
  if (!Array.isArray(chain['txReceipts'])) throw new Error('BROWSERVM_CHECKPOINT_RECEIPTS_INVALID');
  return {
    blockHeight: boundaryInteger(chain['blockHeight'], 'BROWSERVM_CHECKPOINT_HEIGHT_INVALID'),
    blockHash: boundaryString(chain['blockHash'], 'BROWSERVM_CHECKPOINT_HASH_INVALID'),
    blockTimestamp: boundaryInteger(chain['blockTimestamp'], 'BROWSERVM_CHECKPOINT_TIMESTAMP_INVALID'),
    entityProviderDeploymentBlock: boundaryInteger(
      chain['entityProviderDeploymentBlock'],
      'BROWSERVM_CHECKPOINT_ENTITY_PROVIDER_BLOCK_INVALID',
    ),
    blockHashes: decodeStringPairArray(chain['blockHashes'], 'BROWSERVM_CHECKPOINT_BLOCK_HASHES_INVALID'),
    blockReceiptRoots: decodeStringPairArray(
      chain['blockReceiptRoots'],
      'BROWSERVM_CHECKPOINT_RECEIPT_ROOTS_INVALID',
    ),
    txReceipts: chain['txReceipts'].map(entry => {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error('BROWSERVM_CHECKPOINT_RECEIPT_ENTRY_INVALID');
      return [
        boundaryString(entry[0], 'BROWSERVM_CHECKPOINT_RECEIPT_KEY_INVALID'),
        decodeStoredReceipt(entry[1]),
      ];
    }),
  };
};

export const decodeBrowserVmSerializedState = (value: unknown): BrowserVmSerializedState => {
  const state = boundaryRecord(value, 'BROWSERVM_STATE_INVALID');
  exactBoundaryKeys(state, [
    'version', 'chainId', 'stateRoot', 'trieData', 'nonce',
    'entityProviderDeploymentBlock', 'chain', 'addresses',
  ], 'BROWSERVM_STATE_FIELDS_INVALID');
  if (state['version'] !== BROWSERVM_CONTRACT_VERSION) throw new Error('BROWSERVM_STATE_VERSION_INVALID');
  if (!Array.isArray(state['trieData'])) throw new Error('BROWSERVM_STATE_TRIE_INVALID');
  const addresses = boundaryRecord(state['addresses'], 'BROWSERVM_STATE_ADDRESSES_INVALID');
  exactBoundaryKeys(addresses, ['depository', 'entityProvider'], 'BROWSERVM_STATE_ADDRESS_FIELDS_INVALID');
  return {
    version: BROWSERVM_CONTRACT_VERSION,
    chainId: boundaryInteger(state['chainId'], 'BROWSERVM_STATE_CHAIN_ID_INVALID'),
    stateRoot: boundaryString(state['stateRoot'], 'BROWSERVM_STATE_ROOT_INVALID'),
    trieData: state['trieData'].map(entry => {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error('BROWSERVM_STATE_TRIE_ENTRY_INVALID');
      return [
        boundaryString(entry[0], 'BROWSERVM_STATE_TRIE_KEY_INVALID'),
        boundaryString(entry[1], 'BROWSERVM_STATE_TRIE_VALUE_INVALID'),
      ];
    }),
    nonce: boundaryString(state['nonce'], 'BROWSERVM_STATE_NONCE_INVALID'),
    entityProviderDeploymentBlock: boundaryInteger(
      state['entityProviderDeploymentBlock'],
      'BROWSERVM_STATE_ENTITY_PROVIDER_BLOCK_INVALID',
    ),
    chain: decodeBrowserVmChainCheckpoint(state['chain']),
    addresses: {
      depository: boundaryString(addresses['depository'], 'BROWSERVM_STATE_DEPOSITORY_INVALID'),
      entityProvider: boundaryString(addresses['entityProvider'], 'BROWSERVM_STATE_ENTITY_PROVIDER_INVALID'),
    },
  };
};

type BrowserVmTrie = { database(): { db: unknown } };
type BrowserVmStateManager = { _trie?: BrowserVmTrie };
type BrowserVmHandle = { stateManager: unknown };
type TrieMapStore = { _database?: unknown; db?: unknown };

const normalizeBrowserVmEvenHex = (hex: string): string => {
  const raw = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  return raw.length % 2 === 1 ? `0${raw}` : raw;
};

const getBrowserVmTrieMap = (vm: BrowserVmHandle, operation: string): Map<unknown, unknown> => {
  const trie = (vm.stateManager as BrowserVmStateManager)._trie;
  if (!trie) {
    throw new Error(`BrowserVM ${operation}: unsupported state manager trie`);
  }
  const store = trie.database().db;
  if (store instanceof Map) return store;
  const record = store as TrieMapStore | null | undefined;
  if (record?._database instanceof Map) return record._database;
  if (record?.db instanceof Map) return record.db;
  throw new Error(`BrowserVM ${operation}: unsupported trie db`);
};

const normalizeBrowserVmHex = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const raw = value.startsWith('0x') ? value.slice(2) : value;
    if (raw.length === 0) return '';
    const normalized = normalizeBrowserVmEvenHex(raw);
    return /^[0-9a-fA-F]+$/.test(normalized) ? normalized : null;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value)).toString('hex');
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (Array.isArray(value)) {
    try {
      return Buffer.from(value).toString('hex');
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') {
    const maybeBuffer = value as { type?: string; data?: unknown };
    if (maybeBuffer.type === 'Buffer' && Array.isArray(maybeBuffer.data)) {
      try {
        return Buffer.from(maybeBuffer.data).toString('hex');
      } catch {
        return null;
      }
    }
  }
  return null;
};

export const normalizeBrowserVmAddress = (value: unknown): string | null => {
  const hex = normalizeBrowserVmHex(value);
  if (hex === null) return null;
  const trimmed = hex.length > 40 ? hex.slice(-40) : hex.padStart(40, '0');
  if (trimmed.length !== 40) return null;
  return trimmed;
};

const hexToBytesSafe = (hex: string): Uint8Array => {
  if (hex.length === 0) return new Uint8Array();
  return hexToBytes(`0x${hex}`);
};

export const serializeBrowserVmTrieData = (vm: BrowserVmHandle): Array<[string, string]> => {
  const trieData: Array<[string, string]> = [];
  const trieMap = getBrowserVmTrieMap(vm, 'serializeState');
  for (const [key, value] of trieMap.entries()) {
    const keyHexRaw = typeof key === 'string'
      ? key
      : Buffer.from(key as Uint8Array).toString('hex');
    const valueHexRaw = typeof value === 'string'
      ? value
      : Buffer.from(value as Uint8Array).toString('hex');
    trieData.push([
      normalizeBrowserVmEvenHex(keyHexRaw),
      normalizeBrowserVmEvenHex(valueHexRaw),
    ]);
  }
  return trieData;
};

export const restoreBrowserVmTrieData = (
  vm: BrowserVmHandle,
  trieData: Array<[string, string]> | undefined,
): void => {
  const trieMap = getBrowserVmTrieMap(vm, 'restoreState');
  trieMap.clear();
  for (const entry of trieData || []) {
    const keyHex = normalizeBrowserVmHex(entry?.[0]);
    const valueHex = normalizeBrowserVmHex(entry?.[1]);
    if (keyHex === null || valueHex === null) {
      throw new Error('BrowserVM restoreState: invalid trie entry');
    }
    // MapDB for MPT uses hex-string keys; keep key as string, values as bytes.
    trieMap.set(keyHex, hexToBytesSafe(valueHex));
  }
};

export const decodeBrowserVmStateRoot = (stateRoot: unknown): Uint8Array => {
  const stateRootHex = normalizeBrowserVmHex(stateRoot);
  if (!stateRootHex) {
    throw new Error('BrowserVM restoreState: invalid stateRoot');
  }
  return hexToBytes(`0x${stateRootHex.padStart(64, '0')}`);
};
