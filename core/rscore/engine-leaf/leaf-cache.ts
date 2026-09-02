/**
 * The Entity account leaf, as the engine already computed it.
 *
 * TypeScript hashes the same leaf a second time whenever the account map
 * folds — the projection reads every field of an Account the engine just
 * sealed. That is redundant work over a body the engine is authoritative for,
 * so the digest it returned is handed to the fold instead.
 *
 * The cache is only ever a shortcut: the map drops an entry the moment
 * TypeScript takes that Account for writing, so a leaf cannot outlive the
 * bytes it certified. With verification on, both digests are compared.
 */
import { computeEntityAccountValueHash } from '../../entity/consensus/state-root';
import type { AccountValueHash } from '../../entity/state/persistent-account-map';
import type { AccountReplica } from '../../types/account';
import { peekEngineAccountLeaf } from './leaf-registry';
import { RSCORE_CUTOVER_VERIFY } from './verify';

export const engineAccountValueHash = (ownerEntityId: string): AccountValueHash =>
  (account: AccountReplica): string => {
    const remembered = peekEngineAccountLeaf(ownerEntityId, account.proofHeader.toEntity);
    if (remembered === undefined) return computeEntityAccountValueHash(account);
    if (!RSCORE_CUTOVER_VERIFY) return remembered;
    const recomputed = computeEntityAccountValueHash(account).toLowerCase();
    if (recomputed !== remembered) {
      throw new Error(
        `RSCORE_CUTOVER_ENGINE_LEAF_STALE:${account.proofHeader.toEntity}:${remembered}:${recomputed}`,
      );
    }
    return recomputed;
  };