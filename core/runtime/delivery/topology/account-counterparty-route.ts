import type { AccountReplica } from '../../../types/account';
import type { EntityState } from '../../../entity/types';
import type { RuntimeReplica } from '../../types';
import { resolveObserverCertifiedAccountCounterpartyProposer } from '../../../entity/account/account-counterparty-route';
import { getCertifiedBoardNodeStore } from '../../../jurisdiction/machine/board-registry';
import { HankoValidationError } from '../../../hanko/codec';
import { normalizeEntityRef } from '../../../support/boundary-guards';

/** Resolve an established Account lane from the counterparty's certified frame Hanko. */
export const resolveCertifiedAccountCounterpartyProposer = async (
  env: RuntimeReplica,
  observerState: EntityState,
  account: AccountReplica,
  counterpartyEntityId: string,
): Promise<string | null> => {
  const hanko = account.counterpartyFrameHanko;
  if (!hanko) return null;
  const counterparty = normalizeEntityRef(counterpartyEntityId);
  if (counterparty !== normalizeEntityRef(account.state.leftEntity) && counterparty !== normalizeEntityRef(account.state.rightEntity)) {
    throw new Error(`ACCOUNT_COUNTERPARTY_ROUTE_ID_MISMATCH:${counterparty}`);
  }
  const frameHash = normalizeEntityRef(account.currentFrame.stateHash);
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
    // signer before the Account boardHankoRefresh arrives. Let Runtime resolve the fresh,
    // current-board-certified Gossip profile; never route to the retired board.
    if (error instanceof HankoValidationError) return null;
    throw error;
  }
};
