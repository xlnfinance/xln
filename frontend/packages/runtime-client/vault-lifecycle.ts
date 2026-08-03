export type VaultSecretFields = Readonly<{
  seed: string;
  mnemonic12?: string;
}>;

export type VaultRuntimeLike = Readonly<{
  id: string;
  seed: string;
  mnemonic12?: string;
  devicePassphrase?: string;
  protectedSecrets?: unknown;
}>;

export const vaultLockDelayMs = (unlockUntil: number, now: number): number => {
  if (!Number.isSafeInteger(unlockUntil) || unlockUntil < 0) {
    throw new Error(`VAULT_UNLOCK_UNTIL_INVALID:${String(unlockUntil)}`);
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error(`VAULT_CLOCK_INVALID:${String(now)}`);
  }
  return Math.max(0, unlockUntil - now);
};

export const unlockVaultRuntime = <TRuntime extends VaultRuntimeLike>(
  runtime: TRuntime,
  secrets: VaultSecretFields,
): TRuntime => {
  if (!secrets.seed.trim()) throw new Error('VAULT_UNLOCK_SEED_REQUIRED');
  const next = {
    ...runtime,
    seed: secrets.seed,
    ...(secrets.mnemonic12 ? { mnemonic12: secrets.mnemonic12 } : {}),
  };
  if (!secrets.mnemonic12) delete (next as { mnemonic12?: string }).mnemonic12;
  return Object.freeze(next) as TRuntime;
};

export const protectVaultRuntime = <TRuntime extends VaultRuntimeLike, TProtection>(
  runtime: TRuntime,
  protection: TProtection,
): TRuntime => {
  const next = { ...runtime, protectedSecrets: protection };
  delete (next as { devicePassphrase?: string }).devicePassphrase;
  return Object.freeze(next) as TRuntime;
};

export const lockVaultRuntime = <TRuntime extends VaultRuntimeLike>(runtime: TRuntime): TRuntime => {
  const next = { ...runtime, seed: '' };
  delete (next as { mnemonic12?: string }).mnemonic12;
  delete (next as { devicePassphrase?: string }).devicePassphrase;
  return Object.freeze(next) as TRuntime;
};

export const replaceVaultRuntime = <TRuntime extends VaultRuntimeLike>(
  runtimes: Readonly<Record<string, TRuntime>>,
  runtimeId: string,
  runtime: TRuntime,
): Record<string, TRuntime> => {
  if (!Object.hasOwn(runtimes, runtimeId)) {
    throw new Error(`VAULT_RUNTIME_NOT_FOUND:${runtimeId}`);
  }
  return { ...runtimes, [runtimeId]: runtime };
};
