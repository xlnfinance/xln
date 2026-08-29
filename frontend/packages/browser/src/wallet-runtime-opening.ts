export type WalletRuntimeLoginType = 'manual' | 'demo';

export type WalletRuntimeOpeningChoice = Readonly<{
  openLocal: boolean;
  forceFresh: boolean;
  hasRecoveryCandidate: boolean;
}>;

export const walletRuntimeOpeningNeedsLocalLookup = (
  choice: WalletRuntimeOpeningChoice,
): boolean => !choice.openLocal && !choice.forceFresh && !choice.hasRecoveryCandidate;

export type WalletRuntimeOpeningInput<
  RecoveryCandidate,
  UnlockDuration extends number | null,
> = Readonly<{
  runtimeId: string;
  name: string;
  labelOverride: string | undefined;
  seed: string;
  mnemonic12: string;
  devicePassphrase: string;
  loginType: WalletRuntimeLoginType;
  unlockDurationMs: UnlockDuration;
  recoveryCandidate: RecoveryCandidate | undefined;
  forceFresh: boolean;
  openLocal: boolean;
  localRuntimeExists: boolean;
}>;

export type WalletRuntimeOpeningPlan<
  RecoveryCandidate,
  UnlockDuration extends number | null,
> =
  | Readonly<{
    action: 'unlock-local';
    runtimeId: string;
    seed: string;
    unlockDurationMs: UnlockDuration;
  }>
  | Readonly<{
    action: 'create-runtime';
    label: string;
    seed: string;
    options: Readonly<{
      loginType: WalletRuntimeLoginType;
      requiresOnboarding: boolean;
      mnemonic12: string | undefined;
      devicePassphrase: string | undefined;
      recoveryCandidate: RecoveryCandidate | undefined;
      skipRecoveryRestore: boolean;
      unlockDurationMs: UnlockDuration;
    }>;
  }>;

const normalizeOptionalMnemonic = (mnemonic: string): string | undefined =>
  mnemonic.trim().split(/\s+/).join(' ') || undefined;

export const resolveWalletRuntimeOpeningPlan = <
  RecoveryCandidate,
  UnlockDuration extends number | null,
>(
  input: WalletRuntimeOpeningInput<RecoveryCandidate, UnlockDuration>,
): WalletRuntimeOpeningPlan<RecoveryCandidate, UnlockDuration> => {
  if (
    input.openLocal
    || (!input.forceFresh && input.recoveryCandidate === undefined && input.localRuntimeExists)
  ) {
    return {
      action: 'unlock-local',
      runtimeId: input.runtimeId,
      seed: input.seed,
      unlockDurationMs: input.unlockDurationMs,
    };
  }
  const label = (input.labelOverride || input.name || '').trim()
    || `Runtime ${input.runtimeId.slice(0, 6)}`;
  return {
    action: 'create-runtime',
    label,
    seed: input.seed,
    options: {
      loginType: input.loginType,
      requiresOnboarding: input.loginType !== 'demo',
      mnemonic12: normalizeOptionalMnemonic(input.mnemonic12),
      devicePassphrase: input.devicePassphrase || undefined,
      recoveryCandidate: input.recoveryCandidate,
      skipRecoveryRestore: input.recoveryCandidate === undefined,
      unlockDurationMs: input.unlockDurationMs,
    },
  };
};
