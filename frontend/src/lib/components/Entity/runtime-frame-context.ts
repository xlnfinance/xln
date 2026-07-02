import type { Env, EnvSnapshot } from '@xln/runtime/xln-api';

export type EntityWorkspaceRuntimeFrameContext = {
  env: Env | EnvSnapshot | null;
  liveEnv: Env | null;
  liveEnvResolver: (() => Env | null) | null;
  envRevision: string;
  history: EnvSnapshot[];
  timeIndex: number;
  isLive: boolean;
  onGoToLive: () => void;
};

export const emptyEntityWorkspaceRuntimeFrameContext: EntityWorkspaceRuntimeFrameContext = {
  env: null,
  liveEnv: null,
  liveEnvResolver: null,
  envRevision: '',
  history: [],
  timeIndex: -1,
  isLive: true,
  onGoToLive: () => undefined,
};
