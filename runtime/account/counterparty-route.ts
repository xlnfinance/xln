import { ethers } from 'ethers';

import type { AccountMachine, EntityState, Env } from '../types';
import { resolveHankoDefaultProposerSignerId } from '../hanko/signing';
import { verifyCanonicalHanko } from '../hanko/claims';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
} from '../jurisdiction/board-registry';

const normalize = (value: string): string => String(value || '').trim().toLowerCase();

/** Resolve an established Account lane from the counterparty's certified frame Hanko. */
export const resolveCertifiedAccountCounterpartyProposer = async (
  env: Env,
  account: AccountMachine,
  counterpartyEntityId: string,
): Promise<string | null> => {
  const hanko = account.counterpartyFrameHanko;
  if (!hanko) return null;
  const counterparty = normalize(counterpartyEntityId);
  if (counterparty !== normalize(account.leftEntity) && counterparty !== normalize(account.rightEntity)) {
    throw new Error(`ACCOUNT_COUNTERPARTY_ROUTE_ID_MISMATCH:${counterparty}`);
  }
  const frameHash = normalize(account.currentFrame.stateHash);
  if (!/^0x[0-9a-f]{64}$/.test(frameHash)) {
    throw new Error(`ACCOUNT_COUNTERPARTY_ROUTE_FRAME_HASH_INVALID:${frameHash || 'missing'}`);
  }
  return resolveHankoDefaultProposerSignerId(hanko, frameHash, counterparty, env);
};

/**
 * Resolve a delivery lane using only the Account witness and the consuming
 * Entity's certified J-prefix. Consensus replay must never inspect another
 * validator's live replica/gossip topology: two validators may host different
 * Entities while replaying the same frame.
 */
export const resolveObserverCertifiedAccountCounterpartyProposer = (
  env: Env,
  observerState: EntityState,
  account: AccountMachine,
  counterpartyEntityId: string,
): string | null => {
  const hanko = account.counterpartyFrameHanko;
  if (!hanko) return null;
  const counterparty = normalize(counterpartyEntityId);
  if (counterparty !== normalize(account.leftEntity) && counterparty !== normalize(account.rightEntity)) {
    throw new Error(`ACCOUNT_COUNTERPARTY_ROUTE_ID_MISMATCH:${counterparty}`);
  }
  const frameHash = normalize(account.currentFrame.stateHash);
  if (!/^0x[0-9a-f]{64}$/.test(frameHash)) {
    throw new Error(`ACCOUNT_COUNTERPARTY_ROUTE_FRAME_HASH_INVALID:${frameHash || 'missing'}`);
  }
  const expectedTarget = ethers.toBeHex(BigInt(counterparty), 32).toLowerCase() as `0x${string}`;
  const store = getCertifiedBoardNodeStore(env);
  const timestampSeconds = Math.floor(observerState.timestamp / 1_000);
  const verified = verifyCanonicalHanko({
    hanko,
    digest: frameHash,
    expectedTargetEntityId: expectedTarget,
    validateBoardAuthority: (entityId, reconstructedBoardHash) => {
      const record = resolveObserverCertifiedBoardRecord(observerState, store, entityId);
      if (!record) return false;
      if (record.boardHash === reconstructedBoardHash) return true;
      return record.previousBoardHash !== ethers.ZeroHash &&
        record.previousBoardHash === reconstructedBoardHash &&
        timestampSeconds < record.previousBoardValidUntil;
    },
  });
  const target = verified.claims.at(-1);
  const firstMember = String(target?.members[0]?.entityId || '').toLowerCase();
  if (!target || target.entityId !== expectedTarget) {
    throw new Error(
      `HANKO_PROPOSER_TARGET_MISMATCH:expected=${expectedTarget}:actual=${target?.entityId ?? 'missing'}`,
    );
  }
  if (!/^0x0{24}[0-9a-f]{40}$/.test(firstMember)) {
    throw new Error(`HANKO_PROPOSER_FIRST_MEMBER_INVALID:${firstMember || 'missing'}`);
  }
  return ethers.getAddress(`0x${firstMember.slice(-40)}`).toLowerCase();
};
