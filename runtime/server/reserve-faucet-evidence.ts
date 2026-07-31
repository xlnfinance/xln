import { ethers } from 'ethers';
import type { RuntimeReplica } from '../runtime/types';
import {
  findReserveUpdatedEvidence,
  type ReserveUpdatedEvidence,
} from '../jurisdiction/machine/event-evidence';

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

export const waitForReserveUpdatedEvidence = async (
  env: RuntimeReplica,
  entityId: string,
  tokenId: number,
  expectedMin: bigint,
  timeoutMs = 5000,
  pollMs = 50,
): Promise<ReserveUpdatedEvidence | null> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const event = findReserveUpdatedEvidence(env, entityId, tokenId, expectedMin);
    if (event) return event;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return findReserveUpdatedEvidence(env, entityId, tokenId, expectedMin);
};

export { findReserveUpdatedEvidence };
