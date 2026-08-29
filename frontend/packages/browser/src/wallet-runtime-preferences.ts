export const WALLET_AUTH_SCHEME_STORAGE_KEY = 'xln-auth-scheme';

export type WalletAuthScheme = 'dark' | 'light';
export type WalletUnlockDurationChoice = '10m' | '1d' | 'forever';

const ONE_DAY_MS = 86_400_000;

export const resolveWalletAuthScheme = (storedValue: string | null): WalletAuthScheme =>
  storedValue === 'light' ? 'light' : 'dark';

export const resolveWalletUnlockDurationMs = <ShortDuration extends number | null>(
  choice: WalletUnlockDurationChoice,
  shortDurationMs: ShortDuration,
): ShortDuration | typeof ONE_DAY_MS | null => {
  if (choice === 'forever') return null;
  if (choice === '1d') return ONE_DAY_MS;
  return shortDurationMs;
};

export const parseWalletBrainVaultWorkerCap = (storedValue: string | null): number | null => {
  const value = Number(storedValue);
  if (!Number.isFinite(value)) return null;
  const integer = Math.floor(value);
  return integer > 0 ? integer : null;
};

export const serializeWalletBrainVaultWorkerCap = (cap: number): string =>
  String(Math.max(1, Math.floor(cap)));
