import { FetchResponse, isError } from 'ethers';
import { isRecord } from '../../../../../core/support/boundary-guards';
import { preflightRpcError, RpcEnvironmentError } from '../../provider';
import { ObservationUnavailable } from '../boundary';

export const rpcIssue = (error: unknown): string => {
  if (error instanceof ObservationUnavailable || error instanceof RpcEnvironmentError) return error.code;
  const response = isRecord(error) ? error['response'] : null;
  if (response instanceof FetchResponse) return `RPC_HTTP_${response.statusCode}`;
  if (isError(error, 'NETWORK_ERROR') || isError(error, 'SERVER_ERROR') || isError(error, 'TIMEOUT'))
    return preflightRpcError(error).message;
  if (isError(error, 'UNKNOWN_ERROR') && isRecord(error['error']) && typeof error['error']['code'] === 'number')
    return preflightRpcError(error).message;
  throw error;
};

export const bounded = async <T>(read: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ObservationUnavailable('USDC_STATUS_RPC_OBSERVATION_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
