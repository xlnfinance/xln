import {
  applyAccountEnvelopeUpdate,
  type AccountEnvelopeUpdate,
} from '../account/envelope/entity-update';
import type { AccountReplica } from '../types/account';
import type { EntityRuntimeContext } from './runtime-context';

/**
 * Canonical Entity-owned Account-envelope transition.
 *
 * Sequential TS mutates the live candidate directly. A resident Account
 * authority receives the same typed transition and applies it on the owning
 * shard before AccountTx admission and proposal. No state copy or root fallback
 * is permitted between these two execution modes.
 */
export const applyEntityAccountEnvelopeUpdate = (
  env: EntityRuntimeContext,
  accountId: string,
  account: AccountReplica,
  update: AccountEnvelopeUpdate,
): ReturnType<typeof applyAccountEnvelopeUpdate> => {
  const result = applyAccountEnvelopeUpdate(account, update);
  env.accountAuthorityEntityStage?.recordAccountEnvelopeUpdate(accountId, update);
  return result;
};
