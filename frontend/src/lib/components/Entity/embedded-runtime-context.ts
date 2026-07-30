import type { RuntimeReplica, EnvSnapshot } from '@xln/runtime/api/runtime-module';

export type EntityWorkspaceEmbeddedRuntimeContext = {
  env: RuntimeReplica | EnvSnapshot | null;
  liveEnv: RuntimeReplica | null;
  liveEnvResolver: (() => RuntimeReplica | null) | null;
  history: EnvSnapshot[];
};

export const emptyEntityWorkspaceEmbeddedRuntimeContext: EntityWorkspaceEmbeddedRuntimeContext = {
  env: null,
  liveEnv: null,
  liveEnvResolver: null,
  history: [],
};
