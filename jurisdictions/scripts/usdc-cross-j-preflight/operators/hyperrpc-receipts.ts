import { ethers } from 'ethers';
import { readPositiveIntegerEnv } from '../../../../core/config/environment';
import { RpcTransportUnavailableError, TRANSIENT_RPC_HTTP_STATUSES } from '../../../../core/jurisdiction/adapter/kernel/failure';
import { MAX_RPC_BATCH_CALLS, sendRpcBatch, type RpcBatchRequest } from '../../../../core/jurisdiction/adapter/rpc-utils';
import { createHeaderReadQueue, requireLiveHeaderClient } from './header-read-queue';
import { createReadPacer } from './read-pacing';

const sizeName = 'POC_HYPERRPC_ETHEREUM_RECEIPT_BATCH_CALLS';

const decodeBatch = (params: readonly unknown[], limit: number): RpcBatchRequest[] => {
  const [heights] = params;
  if (params.length !== 1 || !Array.isArray(heights) || heights.length < 1 || heights.length > limit)
    throw new Error('USDC_HYPERRPC_RECEIPT_BATCH_SIZE_INVALID');
  let previousHeight = 0;
  return heights.map((height: unknown, index) => {
    if (typeof height !== 'number' || !Number.isSafeInteger(height) || height <= previousHeight)
      throw new Error('USDC_HYPERRPC_RECEIPT_HEIGHT_INVALID');
    previousHeight = height;
    return { id: index + 1, jsonrpc: '2.0', method: 'eth_getBlockReceipts', params: [ethers.toQuantity(height)] };
  });
};

const readBatch = async (rpc: string, batch: RpcBatchRequest[]) => {
  const replies = await sendRpcBatch(rpc, batch, 10_000);
  if (replies.size !== batch.length) throw new Error('USDC_HYPERRPC_RECEIPT_REPLY_COUNT_INVALID');
  return batch.map(({ id }) => {
    const reply = replies.get(id);
    const status = reply?.error?.code;
    if (status !== undefined && TRANSIENT_RPC_HTTP_STATUSES.has(status))
      throw new RpcTransportUnavailableError(`USDC_HYPERRPC_RECEIPT_HTTP_${status}`);
    if (!reply || reply.error || !Object.hasOwn(reply, 'result')) throw new Error('USDC_HYPERRPC_RECEIPT_REPLY_INVALID');
    return reply.result;
  });
};

export const createHyperRpcReceiptReader = () => {
  if (process.env[sizeName] === undefined) return undefined;
  const limit = readPositiveIntegerEnv(sizeName, MAX_RPC_BATCH_CALLS);
  if (limit > MAX_RPC_BATCH_CALLS) throw new Error('USDC_HYPERRPC_RECEIPT_BATCH_LIMIT_INVALID');
  const raw = process.env['POC_HYPERRPC_11155111_RPC'];
  if (!raw || !URL.canParse(raw) || new URL(raw).protocol !== 'https:')
    throw new Error('USDC_HYPERRPC_ETHEREUM_URL_INVALID');
  const queue = createHeaderReadQueue();
  const pace = createReadPacer();
  const trace = process.env['POC_HEADER_BATCH_TIMING'] === '1';
  return async (params: readonly unknown[], signal: AbortSignal) => {
    const batch = decodeBatch(params, limit);
    const release = await queue.acquire(signal);
    try {
      // The PoC uses the five-request-per-minute HyperRPC quota.
      await pace(raw, 12_500, signal);
      requireLiveHeaderClient(signal);
      const started = performance.now();
      let result = 'reply';
      try {
        return await readBatch(raw, batch);
      } catch (error) {
        result = error instanceof RpcTransportUnavailableError && error.message.endsWith('_429') ? '429' : 'error';
        throw error;
      } finally {
        if (trace) process.stderr.write(`USDC_HYPERRPC_RECEIPTS:${JSON.stringify({
          items: batch.length, sentAt: Math.round(started), ms: Math.round(performance.now() - started), result,
        })}\n`);
      }
    } finally {
      release();
    }
  };
};
