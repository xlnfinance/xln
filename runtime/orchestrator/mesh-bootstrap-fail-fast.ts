export type MeshBootstrapErrorClassification = Readonly<{
  category: 'retryable-transport' | 'fatal';
  message: string;
}>;

export const classifyMeshBootstrapError = (error: unknown): MeshBootstrapErrorClassification => {
  const message = String((error as Error)?.message || error || '');
  const retryable = /(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_[A-Z_]+|fetch failed|socket hang up|Unexpected end of JSON input|response ended prematurely|aborted)/i.test(message);
  return { category: retryable ? 'retryable-transport' : 'fatal', message };
};

export const isExpectedMeshBootstrapError = (error: unknown): boolean =>
  classifyMeshBootstrapError(error).category === 'retryable-transport';

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
