import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import type { RuntimeOverlayRecord } from '../../../../types/account';
import { applySourceHubCrossJurisdictionFillProgress } from '../account-cross-j-followups';

type CrossJurisdictionFillNoticeTx = Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>;

type CrossJurisdictionFillResult = {
  newState: EntityState;
  outputs: EntityInput[];
};

/**
 * Hub-internal fill progress delivered from the canonical book owner to the
 * source Hub (they are sibling Entities of one Runtime). The source Hub owns
 * the ladder seed, so it alone decides when the order is terminal and asks its
 * proposer for the reveal. Users learn the outcome from the pull close.
 */
export const handleCrossJurisdictionFillNoticeEntityTx = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: CrossJurisdictionFillNoticeTx,
  storageChanges: RuntimeOverlayRecord[] = [],
  mutableFrameState = false,
): CrossJurisdictionFillResult => {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const applied = applySourceHubCrossJurisdictionFillProgress(
    env,
    newState,
    entityTx.data,
    outputs,
    storageChanges,
  );
  addMessage(
    newState,
    applied
      ? `🌉 Cross-j fill notice ${entityTx.data.orderId} applied ${entityTx.data.cumulativeFillRatio}`
      : `🌉 Cross-j fill notice ${entityTx.data.orderId} duplicate seq ${Math.floor(Number(entityTx.data.fillSeq))}`,
  );
  return { newState, outputs };
};
