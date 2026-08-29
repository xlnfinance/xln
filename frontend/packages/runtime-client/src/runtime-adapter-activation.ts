export type RemoteRuntimeActivationTarget = Readonly<{
  mode: 'remote';
  runtimeId: string;
  wsUrl: string;
  authKey?: string;
}>;

export type EmbeddedRuntimeActivationTarget = Readonly<{
  mode: 'embedded';
  runtimeId: string;
  registered: boolean;
}>;

export type RuntimeActivationTarget =
  | RemoteRuntimeActivationTarget
  | EmbeddedRuntimeActivationTarget;

export type RuntimeActivationConfig =
  | Omit<RemoteRuntimeActivationTarget, 'mode'> & Readonly<{ mode: 'remote' }>
  | Readonly<{ mode: 'embedded'; runtimeId: string }>;

type RuntimeActivationDependencies = Readonly<{
  readPendingRuntimeId: () => string;
  setPendingRuntimeId: (runtimeId: string) => void;
  isCurrent: (target: RuntimeActivationTarget) => boolean;
  switchAdapter: (config: RuntimeActivationConfig) => Promise<void>;
}>;

export type RemoteRuntimeActivationDependencies<SessionSnapshot> =
  RuntimeActivationDependencies & Readonly<{
    readSessionSnapshot: () => SessionSnapshot;
    restoreSessionSnapshot: (snapshot: SessionSnapshot) => void;
    persistRemote: (target: RemoteRuntimeActivationTarget) => boolean;
  }>;

export type EmbeddedRuntimeActivationDependencies =
  RuntimeActivationDependencies & Readonly<{
    persistEmbedded: () => void;
  }>;

const activationConfig = (target: RuntimeActivationTarget): RuntimeActivationConfig =>
  target.mode === 'remote'
    ? {
        mode: 'remote',
        runtimeId: target.runtimeId,
        wsUrl: target.wsUrl,
        ...(target.authKey ? { authKey: target.authKey } : {}),
      }
    : { mode: 'embedded', runtimeId: target.runtimeId };

export const activateRemoteRuntimeTarget = async <SessionSnapshot>(
  target: RemoteRuntimeActivationTarget,
  dependencies: RemoteRuntimeActivationDependencies<SessionSnapshot>,
): Promise<boolean> => {
  if (!target.wsUrl.trim()) throw new Error(`REMOTE_RUNTIME_WS_MISSING:${target.runtimeId}`);
  const previousSession = dependencies.readSessionSnapshot();
  const previousPendingRuntimeId = dependencies.readPendingRuntimeId();
  if (!dependencies.persistRemote(target)) return false;
  dependencies.setPendingRuntimeId(target.runtimeId);
  if (!dependencies.isCurrent(target)) {
    try {
      await dependencies.switchAdapter(activationConfig(target));
    } catch (error) {
      dependencies.restoreSessionSnapshot(previousSession);
      dependencies.setPendingRuntimeId(previousPendingRuntimeId);
      throw error;
    }
  }
  if (!dependencies.isCurrent(target)) {
    throw new Error(`REMOTE_RUNTIME_SWITCH_TARGET_MISMATCH:${target.runtimeId}`);
  }
  return dependencies.persistRemote(target);
};

export const activateEmbeddedRuntimeTarget = async (
  target: EmbeddedRuntimeActivationTarget,
  dependencies: EmbeddedRuntimeActivationDependencies,
): Promise<boolean> => {
  const previousPendingRuntimeId = dependencies.readPendingRuntimeId();
  dependencies.setPendingRuntimeId(target.runtimeId);
  try {
    if (!target.registered || !dependencies.isCurrent(target)) {
      await dependencies.switchAdapter(activationConfig(target));
    }
  } catch (error) {
    dependencies.setPendingRuntimeId(previousPendingRuntimeId);
    throw error;
  }
  dependencies.persistEmbedded();
  return true;
};
