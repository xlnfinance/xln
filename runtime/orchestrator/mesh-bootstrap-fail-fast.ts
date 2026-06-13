export const isExpectedMeshBootstrapError = (error: unknown): boolean => {
  const message = String((error as Error)?.message || error || '');
  return message.includes('ECONNREFUSED') || message.includes('fetch failed');
};

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
  if (isExpectedMeshBootstrapError(error)) return false;

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
