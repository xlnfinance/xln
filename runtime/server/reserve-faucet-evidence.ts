import { ethers } from 'ethers';
import type { RuntimeState } from '../types';
import {
  findRecentReserveUpdatedEvent,
  type RecentReserveUpdatedEvent,
} from '../jurisdiction/event-evidence';

export type TokenCatalogEntry = {
  tokenId?: number | string | null;
  symbol?: string | null;
  decimals?: number | null;
};

export const parseReserveFaucetAmount = (
  amount: string,
  tokenMeta: Pick<TokenCatalogEntry, 'tokenId' | 'decimals'>,
): bigint => {
  const decimals = tokenMeta.decimals;
  if (typeof decimals !== 'number' || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`FAUCET_TOKEN_DECIMALS_INVALID:${String(tokenMeta.tokenId)}:${String(tokenMeta.decimals)}`);
  }
  return ethers.parseUnits(amount, decimals);
};

export const waitForRecentReserveUpdatedEvent = async (
  env: RuntimeState,
  entityId: string,
  tokenId: number,
  expectedMin: bigint,
  timeoutMs = 5000,
  pollMs = 50,
): Promise<RecentReserveUpdatedEvent | null> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const event = findRecentReserveUpdatedEvent(env, entityId, tokenId, expectedMin);
    if (event) return event;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return findRecentReserveUpdatedEvent(env, entityId, tokenId, expectedMin);
};

export { findRecentReserveUpdatedEvent };
