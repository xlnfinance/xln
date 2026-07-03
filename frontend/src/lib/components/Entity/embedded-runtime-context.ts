import type { Env, EnvSnapshot } from '@xln/runtime/xln-api';

export type EntityWorkspaceEmbeddedRuntimeContext = {
  env: Env | EnvSnapshot | null;
  liveEnv: Env | null;
  liveEnvResolver: (() => Env | null) | null;
  history: EnvSnapshot[];
};

export const emptyEntityWorkspaceEmbeddedRuntimeContext: EntityWorkspaceEmbeddedRuntimeContext = {
  env: null,
  liveEnv: null,
  liveEnvResolver: null,
  history: [],
};
