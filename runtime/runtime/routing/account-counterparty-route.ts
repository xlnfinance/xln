import type { AccountReplica } from '../../types/account';
import type { EntityState } from '../../entity/types';
import type { RuntimeReplica } from '../types';
import { resolveObserverCertifiedAccountCounterpartyProposer } from '../../entity/account/account-counterparty-route';
import { getCertifiedBoardNodeStore } from '../../jurisdiction/machine/board-registry';
import { HankoValidationError } from '../../hanko/codec';

const normalize = (value: string): string => String(value || '').trim().toLowerCase();

/** Resolve an established Account lane from the counterparty's certified frame Hanko. */
export const resolveCertifiedAccountCounterpartyProposer = async (
  env: RuntimeReplica,
  observerState: EntityState,
  account: AccountReplica,
  counterpartyEntityId: string,
): Promise<string | null> => {
  const hanko = account.counterpartyFrameHanko;
  if (!hanko) return null;
  const counterparty = normalize(counterpartyEntityId);
  if (counterparty !== normalize(account.state.leftEntity) && counterparty !== normalize(account.state.rightEntity)) {
    throw new Error(`ACCOUNT_COUNTERPARTY_ROUTE_ID_MISMATCH:${counterparty}`);
  }
  const frameHash = normalize(account.currentFrame.stateHash);
  if (!/^0x[0-9a-f]{64}$/.test(frameHash)) {
    throw new Error(`ACCOUNT_COUNTERPARTY_ROUTE_FRAME_HASH_INVALID:${frameHash || 'missing'}`);
  }
  try {
    return resolveObserverCertifiedAccountCounterpartyProposer(
      getCertifiedBoardNodeStore(env),
      observerState,
      account,
      counterparty,
    );
  } catch (error) {
    // A certified board rotation intentionally invalidates the old transport
    // signer before the Account reseal arrives. Let Runtime resolve the fresh,
    // current-board-certified Gossip profile; never route to the retired board.
    if (error instanceof HankoValidationError) return null;
    throw error;
  }
};
