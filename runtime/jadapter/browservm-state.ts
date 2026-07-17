import { hexToBytes } from '@ethereumjs/util';

// Increment when contract ABI/encoding changes to invalidate cached BrowserVM state.
// v6 gives BrowserVM a deployment nonce namespace and persists its chain domain.
export const BROWSERVM_CONTRACT_VERSION = 6;

export type BrowserVmStoredReceipt = {
  transactionHash: string;
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
  version?: number;
  chainId: number;
  stateRoot: string;
  trieData: Array<[string, string]>;
  nonce: string;
  entityProviderDeploymentBlock?: number;
  chain: BrowserVmChainCheckpoint;
  addresses: {
    depository: string;
    entityProvider: string;
  };
};

type BrowserVmTrie = { database(): { db: unknown } };
type BrowserVmStateManager = { _trie?: BrowserVmTrie };
type BrowserVmHandle = { stateManager: unknown };
type TrieMapStore = { _database?: unknown; db?: unknown };

export const normalizeBrowserVmEvenHex = (hex: string): string => {
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

export const normalizeBrowserVmHex = (value: unknown): string | null => {
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
