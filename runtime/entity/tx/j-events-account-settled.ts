import type { EntityCandidateEffect } from '../types';
import { addMessage } from '../frame-events';
import { getTokenInfo } from '../../account/utils';
import { requireCanonicalJurisdictionEvents } from '../../jurisdiction/event-normalization';
import { createStructuredLogger, shortId } from '../../infra/logger';
import type { FinalizedJEventContext } from './j-events';

const jEventLog = createStructuredLogger('j.event');

/**
 * Observing settlement never mutates Account deltas directly. It updates the
 * local reserve and queues a normalized bilateral claim for Account consensus.
 */
export const applyAccountSettledJEvent = (
  context: FinalizedJEventContext,
  candidateEffects: EntityCandidateEffect[],
): void => {
  const {
    entityState,
    newState,
    event,
    blockNumber,
    accountTxs,
    dirtyAccounts,
  } = context;
  if (event.type !== 'AccountSettled') {
    throw new Error(`J_EVENT_ACCOUNT_SETTLED_ROUTE_MISMATCH:${event.type}`);
  }
  const { leftEntity, rightEntity, tokenId, leftReserve, rightReserve, collateral } =
    event.data;
  const tokenIdNum = Number(tokenId);
  const myEntityId = entityState.entityId.toLowerCase();
  const leftId = String(leftEntity).toLowerCase();
  const rightId = String(rightEntity).toLowerCase();
  const myIsLeft = myEntityId === leftId;
  const myIsRight = myEntityId === rightId;
  if (!myIsLeft && !myIsRight) {
    jEventLog.warn('account_settled.wrong_entity', {
      entity: shortId(entityState.entityId),
      left: shortId(leftId),
      right: shortId(rightId),
    });
    return;
  }
  const counterpartyId = String(myIsLeft ? rightEntity : leftEntity);
  const ownReserve = myIsLeft ? leftReserve : rightReserve;
  if (ownReserve !== undefined && ownReserve !== null) {
    newState.reserves.set(tokenIdNum, BigInt(ownReserve as string | number | bigint));
  } else {
    jEventLog.warn('account_settled.reserve_missing', {
      counterparty: shortId(counterpartyId),
      tokenId: tokenIdNum,
    });
  }
  const account = newState.accounts.get(counterpartyId);
  if (!account) {
    jEventLog.warn('account_settled.account_missing', {
      counterparty: shortId(counterpartyId),
    });
    return;
  }
  dirtyAccounts.add(counterpartyId.toLowerCase());
  account.lastFinalizedJHeight ??= 0;

  const normalized = requireCanonicalJurisdictionEvents([event]);
  if (normalized.length !== 1 || !normalized[0]) {
    jEventLog.warn('account_settled.claim_normalize_failed', {
      tokenId: tokenIdNum,
      counterparty: shortId(counterpartyId),
      block: blockNumber,
    });
    return;
  }
  const jHeight = event.blockNumber ?? blockNumber;
  const jBlockHash = event.blockHash || '';
  accountTxs.push({
    accountId: counterpartyId,
    tx: {
      type: 'j_event_claim',
      data: {
        jHeight,
        jBlockHash,
        events: [structuredClone(normalized[0])],
      },
    },
  });
  candidateEffects.push({
    kind: 'debug',
    payload: {
      level: 'info',
      code: 'REB_STEP',
      step: 4,
      status: 'ok',
      event: 'j_event_claim_queued',
      entityId: entityState.entityId,
      counterpartyId,
      tokenId: tokenIdNum,
      jHeight,
    },
  });
  const token = getTokenInfo(tokenIdNum);
  const collateralDisplay = (Number(collateral) / (10 ** token.decimals)).toFixed(4);
  addMessage(
    newState,
    `⚖️ OBSERVED: ${token.symbol} ${counterpartyId.slice(-4)} | ` +
    `coll=${collateralDisplay} | j-block ${blockNumber} (awaiting 2-of-2)`,
  );
};
