import { ethers } from 'ethers';
import { firstUsableContractAddress } from '../machine/contract-address';

export type DebugEventEmitter = {
  sendDebugEvent(payload: Record<string, unknown>): void;
};

export type RpcBatchRequest = {
  id: number;
  jsonrpc: '2.0';
  method: string;
  params: unknown[];
};

export type RpcBatchResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

const decodeRpcBatchResponse = (value: unknown): RpcBatchResponse => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RPC_BATCH_ITEM_INVALID');
  }
  const item = value as Record<string, unknown>;
  const id = item['id'];
  if (id !== undefined && (!Number.isSafeInteger(id) || Number(id) < 0)) {
    throw new Error('RPC_BATCH_ITEM_ID_INVALID');
  }
  const error = item['error'];
  if (error !== undefined && (!error || typeof error !== 'object' || Array.isArray(error))) {
    throw new Error('RPC_BATCH_ITEM_ERROR_INVALID');
  }
  const errorRecord = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : undefined;
  const errorMessage = typeof errorRecord?.['message'] === 'string'
    ? errorRecord['message']
    : undefined;
  return {
    ...(id === undefined ? {} : { id: Number(id) }),
    ...(Object.hasOwn(item, 'result') ? { result: item['result'] } : {}),
    ...(error === undefined ? {} : errorMessage === undefined ? { error: {} } : { error: { message: errorMessage } }),
  };
};

const DEFAULT_RPC_BATCH_TIMEOUT_MS = 5_000;

export const isDebugEventEmitter = (value: unknown): value is DebugEventEmitter =>
  typeof value === 'object' &&
  value !== null &&
  'sendDebugEvent' in value &&
  typeof value.sendDebugEvent === 'function';

export const firstAddress = (...values: Array<unknown>): string =>
  firstUsableContractAddress(...values) ?? '';

export const sendRpcBatch = async (
  rpcUrl: string,
  batch: RpcBatchRequest[],
  timeoutMs = DEFAULT_RPC_BATCH_TIMEOUT_MS,
): Promise<Map<number, RpcBatchResponse>> => {
  if (batch.length === 0) return new Map();
  const controller = new AbortController();
  const timeoutHandle = timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(`RPC_BATCH_TIMEOUT:${timeoutMs}`);
    }
    throw error;
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
  if (!response.ok) {
    throw new Error(`RPC_BATCH_HTTP_${response.status}`);
  }
  const json: unknown = await response.json();
  if (!Array.isArray(json)) {
    throw new Error('RPC_BATCH_INVALID_RESPONSE');
  }
  const byId = new Map<number, RpcBatchResponse>();
  for (const rawItem of json) {
    const item = decodeRpcBatchResponse(rawItem);
    if (item.id !== undefined) {
      byId.set(item.id, item);
    }
  }
  return byId;
};

export const linkArtifactBytecode = (
  bytecode: string,
  libraries: Record<string, string>,
): string => {
  let linked = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;

  for (const [libraryName, address] of Object.entries(libraries)) {
    if (!address) {
      throw new Error(`Missing linked library address for ${libraryName}`);
    }
    const normalizedAddress = address.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(normalizedAddress)) {
      throw new Error(`Invalid linked library address for ${libraryName}: ${address}`);
    }
    // solc identifies each linked library by the first 34 hex characters of
    // keccak256("source.sol:Library"). Replacing the generic placeholder regex
    // would silently point *every* library at the first supplied address. That
    // happened to work while Depository linked only Account, then became a
    // mainnet deployment failure as soon as Bounds and Registry were split out.
    const placeholderHash = ethers.id(libraryName).slice(2, 36);
    const placeholder = `__$${placeholderHash}$__`;
    if (!linked.includes(placeholder)) {
      throw new Error(`Linked library placeholder not found for ${libraryName}`);
    }
    linked = linked.split(placeholder).join(normalizedAddress);
  }

  if (/__\$[0-9a-fA-F]{34}\$__/.test(linked)) {
    throw new Error('Unresolved library placeholders remain in linked bytecode');
  }

  return `0x${linked}`;
};
