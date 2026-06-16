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

export const deriveAccountWatchSeed = (params: {
  runtimeSeed: string | Uint8Array;
  runtimeId?: string | null;
  entityId: string;
  counterpartyId: string;
  timestamp: number;
}): string => {
  const runtimeSeed = typeof params.runtimeSeed === 'string'
    ? params.runtimeSeed
    : ethers.hexlify(params.runtimeSeed);
  if (!runtimeSeed) throw new Error('ACCOUNT_WATCH_SEED_RUNTIME_SEED_MISSING');
  const timestamp = Math.max(0, Math.floor(Number(params.timestamp || 0)));
  return ethers.keccak256(ethers.toUtf8Bytes([
    ACCOUNT_WATCH_SEED_DOMAIN,
    runtimeSeed,
    String(params.runtimeId || '').toLowerCase(),
    String(params.entityId || '').toLowerCase(),
    String(params.counterpartyId || '').toLowerCase(),
    String(timestamp),
  ].join('|'))).toLowerCase();
};
