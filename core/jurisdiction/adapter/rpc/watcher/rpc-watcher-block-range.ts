import { RpcTransportUnavailableError, TRANSIENT_RPC_HTTP_STATUSES } from '../../kernel/failure';
import type { RpcBlockRangeReader, RpcReceiptBatch } from '../../receipt/reader';
import { sendRpcBatch } from '../../rpc-utils';

export const RPC_BLOCK_RANGE_METHOD = 'xln_getBlockRange';
export const RPC_RECEIPT_BATCH_METHOD = 'xln_getReceiptBatch';
// The gateway deadline includes admission, provider pacing and the response.
const GATEWAY_ARRAY_READ_TIMEOUT_MS = 60_000;

const createGatewayArrayReader = (rpcUrl: string, method: string, timeout: number) => {
  if (!rpcUrl) throw new Error('J_BLOCK_RANGE_RPC_URL_MISSING');
  return async (params: unknown[]) => {
    const replies = await sendRpcBatch(rpcUrl, [{
      jsonrpc: '2.0', id: 1, method, params,
    }], timeout);
    const reply = replies.get(1);
    if (reply?.error?.code !== undefined && TRANSIENT_RPC_HTTP_STATUSES.has(reply.error.code)) {
      throw new RpcTransportUnavailableError(`J_WATCHER_GATEWAY_HTTP_${reply.error.code}:${method}`);
    }
    if (replies.size !== 1 || reply?.error || !Array.isArray(reply?.result)) {
      throw new Error(`J_WATCHER_GATEWAY_REPLY_INVALID:${method}`);
    }
    return reply.result;
  };
};

export const createRpcBlockRangeReader = (rpcUrl: string): RpcBlockRangeReader => {
  const read = createGatewayArrayReader(rpcUrl, RPC_BLOCK_RANGE_METHOD, GATEWAY_ARRAY_READ_TIMEOUT_MS);
  return (from, to) => read([from, to]);
};

export const createRpcReceiptBatch = (rpcUrl: string, maxBlocks: number): RpcReceiptBatch => {
  const read = createGatewayArrayReader(rpcUrl, RPC_RECEIPT_BATCH_METHOD, GATEWAY_ARRAY_READ_TIMEOUT_MS);
  return { maxBlocks, read: heights => read([heights]) };
};
