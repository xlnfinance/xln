import { ethers } from 'ethers';

const ACCOUNT_WATCH_SEED_RE = /^0x[0-9a-fA-F]{64}$/;
const ACCOUNT_WATCH_SEED_DOMAIN = 'xln:account-watch-seed:v1';

export const isAccountWatchSeed = (value: unknown): value is string =>
  typeof value === 'string' && ACCOUNT_WATCH_SEED_RE.test(value);

export const normalizeAccountWatchSeed = (value: unknown, context: string): string => {
  if (!isAccountWatchSeed(value)) {
    throw new Error(`${context}:ACCOUNT_WATCH_SEED_INVALID`);
  }
  return value.toLowerCase();
};

/**
 * A watch seed must be reproducible from identity alone: the same Account,
 * re-derived after a retry, restart or recovery, has to yield the same seed or
 * a watchtower cannot match what it was given. Nothing time-varying may enter
 * this hash - the signature takes no timestamp for that reason.
 */
export const deriveAccountWatchSeed = (params: {
  runtimeSeed: string | Uint8Array;
  runtimeId?: string | null;
  entityId: string;
  counterpartyId: string;
}): string => {
  const runtimeSeed = typeof params.runtimeSeed === 'string'
    ? params.runtimeSeed
    : ethers.hexlify(params.runtimeSeed);
  if (!runtimeSeed) throw new Error('ACCOUNT_WATCH_SEED_RUNTIME_SEED_MISSING');
  return ethers.keccak256(ethers.toUtf8Bytes([
    ACCOUNT_WATCH_SEED_DOMAIN,
    runtimeSeed,
    String(params.runtimeId || '').toLowerCase(),
    String(params.entityId || '').toLowerCase(),
    String(params.counterpartyId || '').toLowerCase(),
  ].join('|'))).toLowerCase();
};
