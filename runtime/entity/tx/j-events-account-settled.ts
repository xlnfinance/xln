import { haltRuntimeFailure } from "../../protocol/errors/failure-taxonomy";

import type { EntityCandidateEffect, EntityState } from '../types';
import type { AccountReplica } from '../../types/account';
import { addMessage } from '../frame-events';
import { formatTokenAmount } from '../../account/financial-utils';
import { requireCanonicalJurisdictionEvents } from '../../jurisdiction/machine/events/event-normalization';
import { createStructuredLogger, shortId } from '../../infra/logger';
import { getEntityAccountForWrite } from '../state/persistent-account-map';
import type { FinalizedJEventContext } from './j-events';

const jEventLog = createStructuredLogger('j.event');

const applyObservedReserve = (
  state: EntityState,
  tokenId: number,
  ownReserve: unknown,
  counterpartyId: string,
): void => {
  if (ownReserve !== undefined && ownReserve !== null) {
    state.reserves.set(tokenId, BigInt(ownReserve as string | number | bigint));
    return;
  }
  jEventLog.warn('account_settled.reserve_missing', {
    counterparty: shortId(counterpartyId),
    tokenId,
  });
};

const suppressNonActiveAccountClaim = (
  state: EntityState,
  account: AccountReplica,
  counterpartyId: string,
): boolean => {
  const status = account.status ?? 'active';
  if (status === 'active') return false;
  addMessage(
    state,
    `⚖️ OBSERVED: non-active Account ${counterpartyId.slice(-4)} reserve updated; ` +
      `bilateral claim suppressed (${status})`,
  );
  return true;
};

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
    throw haltRuntimeFailure("J_EVENT_ACCOUNT_SETTLED_ROUTE_MISMATCH", `J_EVENT_ACCOUNT_SETTLED_ROUTE_MISMATCH:${event.type}`);
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
  applyObservedReserve(newState, tokenIdNum, ownReserve, counterpartyId);
  const visible = newState.accounts.get(counterpartyId);
  if (!visible) {
    jEventLog.warn('account_settled.account_missing', {
      counterparty: shortId(counterpartyId),
    });
    return;
  }
  // A persisted dispute_preparing Account has no return-to-active transition:
  // the sole empty-result return happens atomically inside the initial prepare
  // EntityTx, before another certified J range can interleave. Preserve claims
  // already frozen by that EntityTx, but never append attacker-fillable work
  // while the peer ACK lane is closed. Entity reserve finality above remains
  // unconditional; terminal on-chain dispute finality owns Account economics.
  if (suppressNonActiveAccountClaim(newState, visible, counterpartyId)) return;
  const account = getEntityAccountForWrite(newState.accounts, counterpartyId);
  if (!account) throw new Error(`ACCOUNT_SETTLED_WRITE_ACCOUNT_MISSING:${counterpartyId}`);
  dirtyAccounts.add(counterpartyId.toLowerCase());
  account.state.lastFinalizedJHeight ??= 0;

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
  const collateralDisplay = formatTokenAmount(
    tokenIdNum,
    BigInt(collateral as string | number | bigint),
  );
  addMessage(
    newState,
    `⚖️ OBSERVED: ${counterpartyId.slice(-4)} | ` +
    `coll=${collateralDisplay} | j-block ${blockNumber} (awaiting 2-of-2)`,
  );
};
