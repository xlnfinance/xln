import type { XLNModule } from './runtime-module';

const REQUIRED_BOOTSTRAP_FUNCTIONS = [
  'main',
  'processRuntime',
  'getEnv',
  'registerEnvChangeCallback',
  'enqueueRuntimeInput',
  'extractEntityId',
  'parseReplicaKey',
  'getEntityShortId',
  'formatTokenAmount',
] as const satisfies readonly (keyof XLNModule)[];

export function isXLNModuleLoaded(module: unknown): module is XLNModule {
  if (typeof module !== 'object' || module === null) return false;

  const candidate = module as Record<string, unknown>;
  return REQUIRED_BOOTSTRAP_FUNCTIONS.every(
    (exportName) => typeof candidate[exportName] === 'function',
  );
}
