import type { RuntimeState, EnvSnapshot } from '@xln/runtime/api/runtime-module';

export type EntityWorkspaceEmbeddedRuntimeContext = {
  env: RuntimeState | EnvSnapshot | null;
  liveEnv: RuntimeState | null;
  liveEnvResolver: (() => RuntimeState | null) | null;
  history: EnvSnapshot[];
};

export const emptyEntityWorkspaceEmbeddedRuntimeContext: EntityWorkspaceEmbeddedRuntimeContext = {
  env: null,
  liveEnv: null,
  liveEnvResolver: null,
  history: [],
};
