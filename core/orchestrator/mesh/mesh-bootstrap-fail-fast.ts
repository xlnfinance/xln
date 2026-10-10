import { isRpcTransportUnavailable } from '../../jurisdiction/adapter/kernel/failure';

type MeshBootstrapErrorClassification = Readonly<{
  category: 'retryable-transport' | 'fatal';
  message: string;
}>;

// Exact codes the network stacks attach to transport failures: Node/undici,
// Bun fetch, and ethers. Message text never decides retry: a bootstrap
// invariant whose message merely mentions "aborted" must still fail fast.
const RETRYABLE_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_ABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
  'ABORT_ERR',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'TIMEOUT',
]);
const RETRYABLE_TRANSPORT_NAMES: ReadonlySet<string> = new Set(['AbortError', 'TimeoutError']);

const nestedErrors = (error: unknown): unknown[] => {
  if (!error || typeof error !== 'object') return [];
  const record = error as { cause?: unknown; error?: unknown; info?: { error?: unknown } };
  return [record.cause, record.error, record.info?.error];
};

const isRetryableTransportError = (error: unknown, depth = 0): boolean => {
  if (!error || typeof error !== 'object' || depth > 6) return false;
  if (isRpcTransportUnavailable(error)) return true;
  const { code, name } = error as { code?: unknown; name?: unknown };
  if (typeof code === 'string' && RETRYABLE_TRANSPORT_CODES.has(code)) return true;
  if (typeof name === 'string' && RETRYABLE_TRANSPORT_NAMES.has(name)) return true;
  return nestedErrors(error).some(nested => isRetryableTransportError(nested, depth + 1));
};

const classifyMeshBootstrapError = (error: unknown): MeshBootstrapErrorClassification => ({
  category: isRetryableTransportError(error) ? 'retryable-transport' : 'fatal',
  message: error instanceof Error ? error.message : String(error),
});

export type MeshBootstrapLoopErrorHandlerOptions = {
  nodeName: string;
  isShuttingDown?: () => boolean;
  clearLoop?: () => void;
  exit?: (code: number) => void;
  logError?: (...args: unknown[]) => void;
};

export const handleMeshBootstrapLoopError = (
  error: unknown,
  options: MeshBootstrapLoopErrorHandlerOptions,
): boolean => {
  if (options.isShuttingDown?.()) return false;
  const classification = classifyMeshBootstrapError(error);
  if (classification.category === 'retryable-transport') {
    options.logError?.(`[${options.nodeName}] mesh bootstrap transport retry:`, {
      node: options.nodeName,
      category: classification.category,
      message: classification.message,
    });
    return false;
  }

  const err = error instanceof Error ? error : new Error(String(error));
  const payload = {
    node: options.nodeName,
    message: err.message,
    stack: err.stack || '',
  };
  options.logError?.(`[${options.nodeName}] mesh bootstrap tick fatal; shutting down:`, payload);
  options.clearLoop?.();
  options.exit?.(1);
  return true;
};
