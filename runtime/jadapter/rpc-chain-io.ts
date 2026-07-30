import type { Signer } from 'ethers';
import { ethers } from 'ethers';
import { normalizeReceiptHash, parseReceiptQuantity } from '../jurisdiction/receipt-codec';
import { applyJBlockHeadersIngressTransform } from './watcher';
import type { RpcBatchCall } from './receipt-root';
import {
  applyGasHeadroom,
  decodeRpcReceipt,
  asRpcTxResponse,
  type FeeOverrides,
  type RpcReceipt,
} from './rpc-boundary';
import { isTronChainId } from './rpc-public';
import {
  sendRpcBatch,
  type RpcBatchRequest,
  type RpcBatchResponse,
} from './rpc-utils';
import type { JAdapterConfig } from './types';
import { resolveRpcFinalityDepth } from './rpc-finality';

export type RpcChainIo = {
  buildFeeOverrides(): Promise<FeeOverrides>;
  waitForReceipt(txLike: unknown, label: string): Promise<RpcReceipt>;
  signerForPrivateKey(privateKey: string): Promise<Signer>;
  estimateGas(estimate: () => Promise<bigint>): Promise<bigint>;
  readCurrentBlockNumber(): Promise<number>;
  readSafeBlockNumber(): Promise<number>;
  readBlockHeaders(heights: number[]): Promise<Array<{ jHeight: number; jBlockHash: string }>>;
  sendAuthenticatedBatch(calls: readonly RpcBatchCall[]): Promise<unknown[]>;
  resolveFinalityDepth(scenarioMode: boolean): number;
};

type ChainIoSettings = {
  gasHeadroomBps: number;
  maxFeePerGasWei: bigint;
  txWaitConfirms: number;
  txWaitTimeoutMs: number;
};

const readSettings = (config: JAdapterConfig): ChainIoSettings => ({
  gasHeadroomBps: Math.max(10_000, Math.floor(Number(process.env['JADAPTER_GAS_HEADROOM_BPS'] ?? '12000'))),
  maxFeePerGasWei: ethers.parseUnits(
    String(Math.max(1, Math.floor(Number(process.env['JADAPTER_MAX_FEE_GWEI'] ?? '200')))),
    'gwei',
  ),
  txWaitConfirms: Math.max(
    1,
    Math.floor(Number(process.env['JADAPTER_TX_WAIT_CONFIRMS'] ?? config.txWaitConfirms ?? 1)),
  ),
  txWaitTimeoutMs: Math.max(
    10_000,
    Math.floor(Number(process.env['JADAPTER_TX_WAIT_TIMEOUT_MS'] ?? config.txWaitTimeoutMs ?? 300_000)),
  ),
});

const createFeeReader = (
  config: JAdapterConfig,
  provider: ethers.JsonRpcProvider,
  maximum: bigint,
): RpcChainIo['buildFeeOverrides'] => async () => {
  if (config.mode === 'tron') return {};
  const feeData = await provider.getFeeData();
  if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
    throw new Error(
      `[JAdapter:rpc] EIP-1559 fee data unavailable for chainId=${config.chainId}. Refusing gasPrice-only mode.`,
    );
  }
  return {
    maxFeePerGas: feeData.maxFeePerGas > maximum ? maximum : feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas > maximum ? maximum : feeData.maxPriorityFeePerGas,
  };
};

const createReceiptWaiter = (settings: ChainIoSettings): RpcChainIo['waitForReceipt'] =>
  async (txLike, label) => {
    const tx = asRpcTxResponse(txLike);
    const receipt = await tx.wait(settings.txWaitConfirms, settings.txWaitTimeoutMs);
    if (!receipt) throw new Error(`${label} transaction not mined (hash=${tx.hash})`);
    return decodeRpcReceipt(receipt);
  };

const createSignerFactory = (
  config: JAdapterConfig,
  provider: ethers.JsonRpcProvider,
  signer: Signer,
): RpcChainIo['signerForPrivateKey'] => async privateKey => {
  const forkable = signer as Signer & { forPrivateKey?: (key: string) => Signer };
  if (config.mode !== 'tron') return new ethers.Wallet(privateKey, provider);
  if (forkable.forPrivateKey) return forkable.forPrivateKey(privateKey);
  const { createTronSigner } = await import('./tron-signer');
  return createTronSigner({
    provider,
    privateKey,
    rpcUrl: String(config.rpcUrl || ''),
    fullHost: config.tronFullHost,
    apiKey: config.tronApiKey || process.env['TRONGRID_API_KEY'],
  });
};

const parseBlockNumber = (raw: unknown): number => {
  let blockNumber: number;
  try {
    blockNumber = Number(BigInt(String(raw)));
  } catch {
    throw new Error(`J_WATCHER_BLOCK_NUMBER_INVALID:${String(raw)}`);
  }
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`J_WATCHER_BLOCK_NUMBER_INVALID:${String(raw)}`);
  }
  return blockNumber;
};

const readTronSolidifiedBlockNumber = async (config: JAdapterConfig): Promise<number> => {
  const fullHost = String(config.tronFullHost || config.rpcUrl || '')
    .replace(/\/jsonrpc\/?$/i, '')
    .replace(/\/$/, '');
  if (!fullHost) throw new Error('TRON_FULL_HOST_MISSING');
  const response = await fetch(`${fullHost}/walletsolidity/getnowblock`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.tronApiKey ? { 'TRON-PRO-API-KEY': config.tronApiKey } : {}),
    },
    body: '{}',
  });
  if (!response.ok) throw new Error(`TRON_SOLIDIFIED_HEAD_HTTP:${response.status}`);
  const payload = (await response.json()) as { block_header?: { raw_data?: { number?: unknown } } };
  return parseBlockNumber(payload.block_header?.raw_data?.number);
};

const sendTronRpcCall = async (
  config: JAdapterConfig,
  request: RpcBatchRequest,
): Promise<RpcBatchResponse> => {
  const rpcUrl = String(config.rpcUrl || '').trim();
  if (!rpcUrl) throw new Error('TRON_RPC_URL_MISSING');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.tronApiKey ? { 'TRON-PRO-API-KEY': config.tronApiKey } : {}),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`TRON_RPC_HTTP:${request.method}:${response.status}`);
    const payload = (await response.json()) as RpcBatchResponse;
    if (payload.id !== request.id) {
      throw new Error(`TRON_RPC_ID_MISMATCH:${request.method}:${request.id}:${String(payload.id)}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`TRON_RPC_TIMEOUT:${request.method}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const sendTronRpcCalls = async (
  config: JAdapterConfig,
  requests: readonly RpcBatchRequest[],
): Promise<Map<number, RpcBatchResponse>> => {
  const responses = new Map<number, RpcBatchResponse>();
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < requests.length) {
      const request = requests[nextIndex++];
      if (!request) return;
      responses.set(request.id, await sendTronRpcCall(config, request));
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, requests.length) }, worker));
  return responses;
};

const sendCalls = async (
  config: JAdapterConfig,
  requests: readonly RpcBatchRequest[],
): Promise<Map<number, RpcBatchResponse>> => {
  if (isTronChainId(config.chainId)) return sendTronRpcCalls(config, requests);
  const rpcUrl = String(config.rpcUrl || '').trim();
  if (!rpcUrl) throw new Error('J_RECEIPT_BATCH_RPC_URL_MISSING');
  return sendRpcBatch(rpcUrl, [...requests]);
};

const createAuthenticatedBatchSender = (
  config: JAdapterConfig,
): RpcChainIo['sendAuthenticatedBatch'] => async calls => {
  if (calls.length === 0) return [];
  const batch: RpcBatchRequest[] = calls.map((call, index) => ({
    id: index + 1,
    jsonrpc: '2.0',
    method: call.method,
    params: call.params,
  }));
  const responses = await sendCalls(config, batch);
  return batch.map(request => {
    const response = responses.get(request.id);
    if (!response) throw new Error(`J_RECEIPT_BATCH_RESPONSE_MISSING:${request.id}:${request.method}`);
    if (response.error) {
      throw new Error(
        `J_RECEIPT_BATCH_CALL_FAILED:${request.id}:${request.method}:${String(response.error.message || 'unknown')}`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
      throw new Error(`J_RECEIPT_BATCH_RESULT_MISSING:${request.id}:${request.method}`);
    }
    return response.result;
  });
};

const createHeaderReader = (
  config: JAdapterConfig,
): RpcChainIo['readBlockHeaders'] => async heights => {
  const canonicalHeights = [...new Set(heights)].sort((left, right) => left - right);
  const requests: RpcBatchRequest[] = canonicalHeights.map(jHeight => ({
    id: jHeight,
    jsonrpc: '2.0',
    method: 'eth_getBlockByNumber',
    params: [ethers.toQuantity(jHeight), false],
  }));
  const responses = await sendCalls(config, requests);
  const headers = requests.map(({ id }) => {
    const response = responses.get(id);
    const block = response?.result && typeof response.result === 'object'
      ? response.result as { hash?: unknown; number?: unknown; parentHash?: unknown }
      : null;
    if (response?.error || !block) {
      throw new Error(`J_HISTORY_HEADER_MISSING:height=${id} error=${String(response?.error?.message || 'none')}`);
    }
    const number = Number(parseReceiptQuantity(block.number, 'HEADER_BLOCK_NUMBER'));
    if (number !== id) throw new Error(`J_HISTORY_HEADER_NUMBER_MISMATCH:expected=${id}:actual=${number}`);
    return {
      jHeight: number,
      jBlockHash: normalizeReceiptHash(block.hash, 'HEADER_BLOCK_HASH'),
      parentHash: normalizeReceiptHash(block.parentHash, 'HEADER_PARENT_HASH'),
    };
  });
  for (let index = 1; index < headers.length; index += 1) {
    const parent = headers[index - 1]!;
    const child = headers[index]!;
    if (child.jHeight === parent.jHeight + 1 && child.parentHash !== parent.jBlockHash) {
      throw new Error(
        `J_HISTORY_HEADER_PARENT_MISMATCH:height=${child.jHeight}:expected=${parent.jBlockHash}:actual=${child.parentHash}`,
      );
    }
  }
  return applyJBlockHeadersIngressTransform(headers.map(({ jHeight, jBlockHash }) => ({ jHeight, jBlockHash })));
};

export const createRpcChainIo = (
  config: JAdapterConfig,
  provider: ethers.JsonRpcProvider,
  signer: Signer,
): RpcChainIo => {
  const settings = readSettings(config);
  const estimateGas = async (estimate: () => Promise<bigint>): Promise<bigint> =>
    applyGasHeadroom(await estimate(), settings.gasHeadroomBps);
  const readCurrentBlockNumber = async (): Promise<number> =>
    parseBlockNumber(await provider.send('eth_blockNumber', []));
  return {
    buildFeeOverrides: createFeeReader(config, provider, settings.maxFeePerGasWei),
    waitForReceipt: createReceiptWaiter(settings),
    signerForPrivateKey: createSignerFactory(config, provider, signer),
    estimateGas,
    readCurrentBlockNumber,
    readSafeBlockNumber: () =>
      isTronChainId(config.chainId) ? readTronSolidifiedBlockNumber(config) : readCurrentBlockNumber(),
    readBlockHeaders: createHeaderReader(config),
    sendAuthenticatedBatch: createAuthenticatedBatchSender(config),
    resolveFinalityDepth: scenarioMode => resolveRpcFinalityDepth(config, scenarioMode),
  };
};
