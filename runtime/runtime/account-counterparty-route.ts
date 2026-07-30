import type { AccountReplica } from '../types/account';
import type { RuntimeReplica } from './types';
import { resolveHankoDefaultProposerSignerId } from '../hanko/signing';

const normalize = (value: string): string => String(value || '').trim().toLowerCase();

/** Resolve an established Account lane from the counterparty's certified frame Hanko. */
export const resolveCertifiedAccountCounterpartyProposer = async (
  env: RuntimeReplica,
  account: AccountReplica,
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
