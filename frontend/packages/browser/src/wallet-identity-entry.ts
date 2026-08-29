export const WALLET_IDENTITY_MODES = Object.freeze(['brainvault', 'mnemonic'] as const);

export type WalletIdentityMode = (typeof WALLET_IDENTITY_MODES)[number];
export type WalletIdentityEntryPhase = 'input' | 'deriving' | 'recovery' | 'node-ready';
export type WalletIdentityRehearsalMode = Extract<WalletIdentityMode, 'mnemonic'>;

export type WalletIdentityEntryState = Readonly<{
  mode: WalletIdentityMode;
  passphrase: string;
  mnemonicInput: string;
  showPassphrase: boolean;
}>;

export type WalletIdentityModeSelection = Readonly<{
  state: WalletIdentityEntryState;
  phase: WalletIdentityEntryPhase;
  rehearsalMode: WalletIdentityRehearsalMode | null;
  nextMode: WalletIdentityMode;
}>;

export const selectWalletIdentityMode = (
  input: WalletIdentityModeSelection,
): WalletIdentityEntryState => {
  const { state, phase, rehearsalMode, nextMode } = input;
  if (phase !== 'input') return state;
  if (rehearsalMode !== null && nextMode !== rehearsalMode) return state;
  if (nextMode === state.mode) return state;
  return {
    mode: nextMode,
    passphrase: state.mode === 'brainvault' ? '' : state.passphrase,
    mnemonicInput: state.mode === 'mnemonic' ? '' : state.mnemonicInput,
    showPassphrase: false,
  };
};

const enabledWalletIdentityModes = (
  rehearsalMode: WalletIdentityRehearsalMode | null,
): readonly WalletIdentityMode[] => rehearsalMode === null
  ? WALLET_IDENTITY_MODES
  : [rehearsalMode];

export const resolveWalletIdentityModeNavigation = (input: Readonly<{
  currentMode: WalletIdentityMode;
  key: string;
  rehearsalMode: WalletIdentityRehearsalMode | null;
}>): WalletIdentityMode | null => {
  const enabledModes = enabledWalletIdentityModes(input.rehearsalMode);
  const currentIndex = enabledModes.indexOf(input.currentMode);
  const nextIndex = input.key === 'Home'
    ? 0
    : input.key === 'End'
      ? enabledModes.length - 1
      : input.key === 'ArrowRight'
        ? (currentIndex + 1) % enabledModes.length
        : input.key === 'ArrowLeft'
          ? (currentIndex - 1 + enabledModes.length) % enabledModes.length
          : -1;
  return nextIndex < 0 ? null : enabledModes[nextIndex] ?? null;
};
