import {
  protectVaultRuntime,
  unlockVaultRuntime,
  vaultLockDelayMs,
} from '../../../packages/runtime-client/vault-lifecycle';
import {
  deleteVaultDeviceKey,
  protectVaultSecrets,
  sameVaultProtectionLease,
  unprotectVaultSecrets,
  type VaultUnlockDurationMs,
} from '../security/vaultProtection';
import {
  installVaultRuntimeCommandJournalKeys,
  type Runtime,
} from './vault-recovery';

export type VaultLifecyclePorts<TTimer> = Readonly<{
  now: () => number;
  schedule: (task: () => void, delayMs: number) => TTimer;
  cancel: (timer: TTimer) => void;
}>;

export const createVaultLockScheduler = <TTimer>(ports: VaultLifecyclePorts<TTimer>) => {
  const timers = new Map<string, TTimer>();
  const cancel = (runtimeId: string): void => {
    const timer = timers.get(runtimeId);
    if (timer !== undefined) ports.cancel(timer);
    timers.delete(runtimeId);
  };
  return Object.freeze({
    cancel,
    schedule: (runtimeId: string, unlockUntil: number | null, task: () => void): void => {
      cancel(runtimeId);
      if (unlockUntil === null) return;
      const timer = ports.schedule(() => {
        timers.delete(runtimeId);
        task();
      }, vaultLockDelayMs(unlockUntil, ports.now()));
      timers.set(runtimeId, timer);
    },
  });
};

export const protectRuntimeForDevice = async (options: {
  runtime: Runtime;
  durationMs: VaultUnlockDurationMs;
  persist: (runtime: Runtime) => void;
  scheduleLock: (runtime: Runtime) => void;
  reportCleanupError: (runtimeId: string, error: unknown) => void;
}): Promise<Runtime> => {
  const { runtime } = options;
  if (!runtime.seed) throw new Error(`RUNTIME_LOCKED:${runtime.id}`);
  const previousProtection = runtime.protectedSecrets;
  const nextProtection = await protectVaultSecrets(runtime.id, {
    seed: runtime.seed,
    ...(runtime.mnemonic12 ? { mnemonic12: runtime.mnemonic12 } : {}),
  }, options.durationMs);
  const protectedRuntime = protectVaultRuntime(runtime, nextProtection);
  try {
    options.persist(protectedRuntime);
  } catch (error) {
    await deleteVaultDeviceKey(runtime.id, nextProtection);
    throw error;
  }
  if (previousProtection && !sameVaultProtectionLease(previousProtection, nextProtection)) {
    try {
      await deleteVaultDeviceKey(runtime.id, previousProtection);
    } catch (error) {
      options.reportCleanupError(runtime.id, error);
    }
  }
  options.scheduleLock(protectedRuntime);
  return protectedRuntime;
};

export const restoreRuntimeFromDevice = async (options: {
  runtime: Runtime;
  scheduleLock: (runtime: Runtime) => void;
}): Promise<Runtime | null> => {
  const { runtime } = options;
  if (runtime.seed) return runtime;
  if (!runtime.protectedSecrets) return null;
  const secrets = await unprotectVaultSecrets(runtime.id, runtime.protectedSecrets);
  if (!secrets) return null;
  const unlockedRuntime = unlockVaultRuntime(runtime, secrets);
  await installVaultRuntimeCommandJournalKeys(runtime.id, unlockedRuntime.seed);
  options.scheduleLock(unlockedRuntime);
  return unlockedRuntime;
};
