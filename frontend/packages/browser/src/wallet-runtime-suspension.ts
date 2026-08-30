export type WalletRuntimeSuspensionTarget = Readonly<{
  infrastructure?: {
    persistenceQuiescing?: boolean;
    persistencePaused?: boolean;
  } | undefined;
}>;

export type WalletRuntimeSuspensionDependencies<Target extends WalletRuntimeSuspensionTarget> = Readonly<{
  stopWatchers: (target: Target) => Promise<void>;
  waitForWorkDrained: (target: Target, timeoutMs: number) => Promise<boolean>;
  stopRuntimeLoop: (target: Target, timeoutMs: number) => Promise<boolean>;
  stopP2P: (target: Target, timeoutMs: number) => Promise<void>;
  describeTarget: (target: Target) => string;
}>;

export type WalletRuntimeSuspensionOptions = Readonly<{
  runtimeDrainTimeoutMs?: number;
  p2pShutdownTimeoutMs?: number;
}>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const drainAcceptedWork = async <Target extends WalletRuntimeSuspensionTarget>(
  target: Target,
  dependencies: WalletRuntimeSuspensionDependencies<Target>,
  timeoutMs: number,
  failures: string[],
): Promise<void> => {
  try {
    if (!await dependencies.waitForWorkDrained(target, timeoutMs)) {
      failures.push(`runtime_work:drain_timeout:${dependencies.describeTarget(target)}`);
    }
  } catch (error: unknown) {
    failures.push(`runtime_work:${errorMessage(error)}:${dependencies.describeTarget(target)}`);
  }
};

export const suspendWalletRuntimeActivity = async <Target extends WalletRuntimeSuspensionTarget>(
  target: Target,
  dependencies: WalletRuntimeSuspensionDependencies<Target>,
  options: WalletRuntimeSuspensionOptions = {},
): Promise<void> => {
  const runtimeTimeout = options.runtimeDrainTimeoutMs ?? 30_000;
  const p2pTimeout = options.p2pShutdownTimeoutMs ?? 10_000;
  const failures: string[] = [];

  // Fence new P2P/J ingress before draining work that was already accepted.
  // The loop stays alive until the drain completes so committed outputs and
  // their transport acknowledgements cannot be stranded during tab takeover.
  if (target.infrastructure) target.infrastructure.persistenceQuiescing = true;

  try {
    await dependencies.stopWatchers(target);
  } catch (error: unknown) {
    failures.push(`watchers:${errorMessage(error)}`);
  }
  await drainAcceptedWork(target, dependencies, runtimeTimeout, failures);
  if (target.infrastructure) target.infrastructure.persistencePaused = true;

  if (!await dependencies.stopRuntimeLoop(target, runtimeTimeout)) {
    failures.push('runtime_loop:drain_timeout');
  }
  try {
    await dependencies.stopP2P(target, p2pTimeout);
  } catch (error: unknown) {
    failures.push(`p2p:${errorMessage(error)}`);
  }
  if (failures.length > 0) throw new Error(`RUNTIME_QUIESCE_FAILED:${failures.join('|')}`);
};
