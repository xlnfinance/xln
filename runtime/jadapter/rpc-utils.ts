import { ethers } from 'ethers';
import type { Provider } from 'ethers';
import { firstUsableContractAddress } from '../contract-address';

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

const RPC_CODE_PROBE_TIMEOUT_MS = 10_000;
export const DEFAULT_RPC_BATCH_TIMEOUT_MS = 5_000;

export const isDebugEventEmitter = (value: unknown): value is DebugEventEmitter =>
  typeof value === 'object' &&
  value !== null &&
  'sendDebugEvent' in value &&
  typeof value.sendDebugEvent === 'function';

export const firstAddress = (...values: Array<unknown>): string =>
  firstUsableContractAddress(...values) ?? '';

export const fetchRpcCode = async (
  rpcUrl: string,
  address: string,
  timeoutMs = RPC_CODE_PROBE_TIMEOUT_MS,
): Promise<string> => {
  if (!ethers.isAddress(address)) {
    throw new Error(`INVALID_CONTRACT_ADDRESS:${String(address)}`);
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [address, 'latest'],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`ETH_GET_CODE_HTTP_${response.status}`);
    }

    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      throw new Error(`ETH_GET_CODE_RPC:${body.error.message || 'unknown'}`);
    }
    if (typeof body.result !== 'string') {
      throw new Error('ETH_GET_CODE_INVALID_RESULT');
    }
    return body.result;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(`ETH_GET_CODE_TIMEOUT:${address}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
};

export const readContractCode = async (
  provider: Provider,
  rpcUrl: string | undefined,
  address: string,
): Promise<string> => {
  const normalizedRpcUrl = String(rpcUrl || '').trim();
  if (normalizedRpcUrl) {
    try {
      return await fetchRpcCode(normalizedRpcUrl, address);
    } catch (error) {
      console.warn(`[JAdapter:rpc] eth_getCode probe failed for ${address}: ${(error as Error).message}`);
    }
  }
  return provider.getCode(address);
};

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
  const json = await response.json();
  if (!Array.isArray(json)) {
    throw new Error('RPC_BATCH_INVALID_RESPONSE');
  }
  const byId = new Map<number, RpcBatchResponse>();
  for (const item of json as RpcBatchResponse[]) {
    if (item && typeof item.id === 'number') {
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
  const unresolvedLibraryRef = /__\$[0-9a-fA-F]{34}\$__/g;

  for (const [libraryName, address] of Object.entries(libraries)) {
    if (!address) {
      throw new Error(`Missing linked library address for ${libraryName}`);
    }
    const normalizedAddress = address.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(normalizedAddress)) {
      throw new Error(`Invalid linked library address for ${libraryName}: ${address}`);
    }
    linked = linked.replace(unresolvedLibraryRef, normalizedAddress);
  }

  if (/__\$[0-9a-fA-F]{34}\$__/.test(linked)) {
    throw new Error('Unresolved library placeholders remain in linked bytecode');
  }

  return `0x${linked}`;
};
