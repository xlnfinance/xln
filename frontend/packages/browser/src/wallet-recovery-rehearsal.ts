import type { WalletIdentityRehearsalMode } from './wallet-identity-entry';

export type WalletRecoveryRehearsalMode = WalletIdentityRehearsalMode;

export type WalletRecoveryRehearsalState = Readonly<{
  enabled: boolean;
  mode: WalletRecoveryRehearsalMode | null;
  expectedAddress: string;
}>;

export const WALLET_RECOVERY_REHEARSAL_MISMATCH =
  'Recovery rehearsal did not reproduce the same wallet. Check every input and try again.';

export const resetWalletRecoveryRehearsal = (): WalletRecoveryRehearsalState => ({
  enabled: false,
  mode: null,
  expectedAddress: '',
});

export type WalletRecoveryRehearsalResult =
  | Readonly<{ status: 'skipped'; state: WalletRecoveryRehearsalState }>
  | Readonly<{ status: 'begin'; state: WalletRecoveryRehearsalState }>
  | Readonly<{
      status: 'mismatch';
      state: WalletRecoveryRehearsalState;
      message: typeof WALLET_RECOVERY_REHEARSAL_MISMATCH;
    }>
  | Readonly<{ status: 'matched'; state: WalletRecoveryRehearsalState }>;

export const evaluateWalletRecoveryRehearsal = (input: Readonly<{
  state: WalletRecoveryRehearsalState;
  mode: WalletRecoveryRehearsalMode;
  address: string;
}>): WalletRecoveryRehearsalResult => {
  if (!input.state.enabled && input.state.mode === null) {
    return { status: 'skipped', state: input.state };
  }
  const normalizedAddress = input.address.toLowerCase();
  if (input.state.mode === null) {
    return {
      status: 'begin',
      state: { ...input.state, mode: input.mode, expectedAddress: normalizedAddress },
    };
  }
  if (input.state.mode !== input.mode || input.state.expectedAddress !== normalizedAddress) {
    return {
      status: 'mismatch',
      state: input.state,
      message: WALLET_RECOVERY_REHEARSAL_MISMATCH,
    };
  }
  return { status: 'matched', state: resetWalletRecoveryRehearsal() };
};
