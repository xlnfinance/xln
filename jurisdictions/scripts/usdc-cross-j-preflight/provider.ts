import { FetchRequest, JsonRpcProvider } from 'ethers';
import { isRecord } from '../../../core/support/boundary-guards';
import { bindRpcReadCancellation } from '../../../core/jurisdiction/adapter/rpc-utils';
import {
  isRpcTransportUnavailable,
  TRANSIENT_RPC_HTTP_STATUSES,
} from '../../../core/jurisdiction/adapter/kernel/failure';

const requestTimeoutMs = 10_000;

/** Preserve numeric upstream availability failures for the watcher's existing
 * bounded backoff. Authority/proof errors and message text cannot mint retries. */
export const preflightRpcError = (error: unknown): { code: number; message: string } => {
  if (isRpcTransportUnavailable(error)) return { code: 503, message: 'RPC_BATCH_HTTP_503' };
  if (isRecord(error)) {
    if (error['code'] === 'TIMEOUT') return { code: -32000, message: `RPC_BATCH_TIMEOUT:${requestTimeoutMs}` };
    let nested = error;
    if (error['code'] === 'UNKNOWN_ERROR' && isRecord(error['error'])) nested = error['error'];
    // ethers wraps every eth_call upstream rejection as CALL_EXCEPTION. A
    // numeric availability response with no revert bytes is still transport.
    else if (error['code'] === 'CALL_EXCEPTION' && error['data'] === null && isRecord(error['info'])) {
      const upstream = error['info']['error'];
      if (isRecord(upstream)) nested = upstream;
    }
    const status = nested['code'];
    if (typeof status === 'number' && TRANSIENT_RPC_HTTP_STATUSES.has(status))
      return { code: status, message: `RPC_BATCH_HTTP_${status}` };
  }
  return { code: -32000, message: 'USDC_PREFLIGHT_RPC_REJECTED' };
};

const methods = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getCode',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockReceipts',
  'eth_getTransactionCount',
  'eth_getBalance',
  'eth_getLogs',
  'eth_getProof',
  'eth_getStorageAt',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
]);

/** No signer or write RPC capability is available to preparation. */
export class PreflightProvider extends JsonRpcProvider {
  override send(method: string, params: Array<unknown> | Record<string, unknown>): Promise<unknown> {
    if (!methods.has(method)) throw new Error(`USDC_PREFLIGHT_RPC_FORBIDDEN:${method}`);
    return super.send(method, params);
  }

  async readForRequest(method: string, params: unknown[], chainId: number, signal: AbortSignal): Promise<unknown> {
    // A disconnected HTTP request must not cancel the unrelated calls on the
    // shared provider. The caller selects the already-bound gateway route.
    const provider = new PreflightProvider(bindRpcReadCancellation(this._getConnection(), signal), chainId, {
      cacheTimeout: -1, staticNetwork: true,
    });
    try {
      return await provider.send(method, params);
    } finally {
      provider.destroy();
    }
  }
}

export const preflightProvider = (url: string, chainId: number, singleObservation = false): PreflightProvider => {
  const request = new FetchRequest(url);
  request.timeout = requestTimeoutMs;
  if (singleObservation) request.retryFunc = async () => false;
  // An observation verifies eth_chainId explicitly. Avoid ethers' background
  // network bootstrap retries so unavailable RPCs remain ordinary evidence gaps.
  return new PreflightProvider(request, chainId, {
    cacheTimeout: -1,
    ...(singleObservation ? { staticNetwork: true } : {}),
  });
};

export const runtimeRpc = (chain: { chainId: number; env: string }): string => {
  const value = process.env[`POC_RUNTIME_${chain.chainId}_RPC`] ?? process.env[chain.env];
  if (!value) throw new RpcEnvironmentError(chain.env);
  return value;
};

export class RpcEnvironmentError extends Error {
  readonly code = 'USDC_PREFLIGHT_RPC_ENV_REQUIRED';
  constructor(env: string) {
    super(`USDC_PREFLIGHT_RPC_ENV_REQUIRED:${env}`);
  }
}
