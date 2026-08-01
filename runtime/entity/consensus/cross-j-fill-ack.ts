const buildCrossJurisdictionAdmissionFillNoticeOutput = (
  currentEntityState: EntityState,
  accountId: string,
  tx: CrossSwapFillAckTx,
): EntityInput | null => {
  const admission = findCrossJurisdictionBookAdmissionForAck(
    currentEntityState,
    accountId,
    tx.data.offerId,
    tx.data.routeHash,
  );
  if (!admission) return null;
  if (admission.status === 'closed' || admission.status === 'resolving') return null;
  const sourceHubEntityId = normalizeEntityRef(admission.route.source.counterpartyEntityId);
  if (!sourceHubEntityId) {
    throw new Error(`CROSS_J_FILL_ACK_SOURCE_HUB_MISSING: account=${accountId} offer=${tx.data.offerId}`);
  }
  if (sourceHubEntityId === normalizeEntityRef(currentEntityState.entityId)) return null;
  const hintedSignerRaw = String(admission.route.sourceHubSignerId || '');
  if (!normalizeEntityRef(hintedSignerRaw)) {
    throw new Error(
      `CROSS_J_FILL_ACK_SOURCE_HUB_SIGNER_MISSING: account=${accountId} offer=${tx.data.offerId} ` +
        `sourceHub=${sourceHubEntityId}`,
    );
  }
  return {
    entityId: sourceHubEntityId,
    signerId: hintedSignerRaw,
    entityTxs: [buildCrossJurisdictionFillNoticeTx(tx, accountId)],
    localRuntimeProtocol: 'cross-j',
  };
};

export const buildCrossJurisdictionFillNoticeOutput = (
  currentEntityState: EntityState,
  accountId: string,
  tx: CrossSwapFillAckTx,
): EntityInput | null => {
  return buildCrossJurisdictionAdmissionFillNoticeOutput(currentEntityState, accountId, tx);
};

const pendingCrossJurisdictionFillAckKey = (accountId: string, tx: CrossSwapFillAckTx): string =>
  [
    normalizeEntityRef(accountId),
    tx.data.offerId,
    Math.floor(Number(tx.data.fillSeq ?? 0)),
    Math.floor(Number(tx.data.cumulativeFillRatio ?? 0)),
    tx.data.cumulativeSourceAmount?.toString() ?? '',
    tx.data.cumulativeTargetAmount?.toString() ?? '',
  ].join('|');

export const ownsSourceHubRouteForFillAck = (currentEntityState: EntityState, tx: CrossSwapFillAckTx): boolean => {
  const route = currentEntityState.crossJurisdictionSwaps?.get(tx.data.offerId);
  if (!route) return false;
  return normalizeEntityRef(route.source.counterpartyEntityId) === normalizeEntityRef(currentEntityState.entityId);
};

export const stashPendingCrossJurisdictionFillAck = (
  env: EntityRuntimeContext,
  currentEntityState: EntityState,
  accountId: string,
  tx: CrossSwapFillAckTx,
  reason: string,
): void => {
  currentEntityState.pendingCrossJurisdictionFillAcks ||= new Map();
  const key = pendingCrossJurisdictionFillAckKey(accountId, tx);
  if (currentEntityState.pendingCrossJurisdictionFillAcks.has(key)) return;
  if (currentEntityState.pendingCrossJurisdictionFillAcks.size >= MAX_PENDING_CROSS_J_FILL_ACKS) {
    throw new Error(
      `CROSS_J_FILL_ACK_PENDING_CAPACITY: entity=${currentEntityState.entityId} ` +
        `account=${accountId} offer=${tx.data.offerId} max=${MAX_PENDING_CROSS_J_FILL_ACKS}`,
    );
  }
  currentEntityState.pendingCrossJurisdictionFillAcks.set(key, {
    accountId,
    tx: cloneCrossJurisdictionAccountTxRoute(tx) as CrossSwapFillAckTx,
    storedAt: currentEntityState.timestamp || env.state.timestamp,
    reason,
  });
  entityLog.info('crossj.fill_ack_deferred', {
    entity: shortId(currentEntityState.entityId, 8),
    account: shortId(accountId, 8),
    offer: shortOrder(tx.data.offerId, 8),
    reason,
  });
};

const admitGeneratedAccountTx = async (
  accountConsensusContext: AccountConsensusContext,
  state: EntityState,
  account: AccountReplica,
  tx: AccountTx,
): Promise<boolean> => {
  const result = await applyAccountInput(
    accountConsensusContext,
    account,
    createLocalAccountInput(account.state, state.entityId, [tx]),
  );
  return result.admittedAccountTxCount === 1;
};

type PendingCrossJurisdictionFillAck =
  NonNullable<EntityState['pendingCrossJurisdictionFillAcks']> extends Map<string, infer Value> ? Value : never;

const queueCrossJFillAckIncidentEffect = (
  candidateEffects: EntityCandidateEffect[],
  kind: 'securityIncidentRecord' | 'securityIncidentResolve',
  state: EntityState,
  pendingAck: PendingCrossJurisdictionFillAck,
): void => {
  candidateEffects.push({
    kind,
    identity: {
      domain: 'cross-j',
      code: 'CROSS_J_FILL_ACK_TTL_EXPIRED',
      source: 'local-consensus',
      severity: 'critical',
      summary: 'A committed sibling fill acknowledgement has no matching local source offer',
      entityId: state.entityId,
      accountId: pendingAck.accountId,
      offerId: pendingAck.tx.data.offerId,
      routeHash: pendingAck.tx.data.routeHash || '',
    },
  });
};

export const drainPendingCrossJurisdictionFillAcks = async (
  env: EntityRuntimeContext,
  accountConsensusContext: AccountConsensusContext,
  currentEntityState: EntityState,
  proposableAccounts: Set<string>,
  storageChanges: RuntimeOverlayRecord[],
  candidateEffects: EntityCandidateEffect[],
  outputs: EntityOutput[],
): Promise<number> => {
  const pending = currentEntityState.pendingCrossJurisdictionFillAcks;
  if (!pending || pending.size === 0) return 0;
  const now = Number(currentEntityState.timestamp || env.state.timestamp || 0);
  let drained = 0;
  for (const [key, pendingAck] of Array.from(pending.entries()).sort(([a], [b]) => compareStableText(a, b))) {
    const ageMs = Math.max(0, now - Number(pendingAck.storedAt || 0));
    if (ageMs > CROSS_J_PENDING_FILL_ACK_TTL_MS && !pendingAck.ttlExpiredAt) {
      const payload = {
        entityId: currentEntityState.entityId,
        accountId: pendingAck.accountId,
        offerId: pendingAck.tx.data.offerId,
        routeHash: pendingAck.tx.data.routeHash || '',
        fillSeq: pendingAck.tx.data.fillSeq,
        previousFillSeq: pendingAck.tx.data.previousFillSeq,
        fillId: buildCrossJurisdictionFillId({
          routeHash: pendingAck.tx.data.routeHash || '',
          offerId: pendingAck.tx.data.offerId,
          ...(pendingAck.tx.data.fillSeq !== undefined ? { fillSeq: pendingAck.tx.data.fillSeq } : {}),
          cumulativeFillRatio: pendingAck.tx.data.cumulativeFillRatio,
          ...(pendingAck.tx.data.cumulativeSourceAmount !== undefined
            ? { cumulativeSourceAmount: pendingAck.tx.data.cumulativeSourceAmount }
            : {}),
          ...(pendingAck.tx.data.cumulativeTargetAmount !== undefined
            ? { cumulativeTargetAmount: pendingAck.tx.data.cumulativeTargetAmount }
            : {}),
        }),
        ackKind: pendingAck.tx.data.ackKind || (pendingAck.tx.data.cancelRemainder ? 'cancel_or_fill' : 'fill'),
        cumulativeFillRatio: pendingAck.tx.data.cumulativeFillRatio,
        cumulativeSourceAmount: pendingAck.tx.data.cumulativeSourceAmount?.toString() ?? '',
        cumulativeTargetAmount: pendingAck.tx.data.cumulativeTargetAmount?.toString() ?? '',
        fillNumerator: pendingAck.tx.data.fillNumerator?.toString() ?? '',
        fillDenominator: pendingAck.tx.data.fillDenominator?.toString() ?? '',
        storedAt: pendingAck.storedAt,
        ageMs,
        ttlMs: CROSS_J_PENDING_FILL_ACK_TTL_MS,
        reason: pendingAck.reason ?? 'unknown',
        repairProtocol: {
          classification: 'unexpected_cross_j_fill_ack_without_local_source_offer',
          preserveEvidence: true,
          operatorAction:
            'Inspect the source-hub route, account swapOffers, pending frames, and book-owner admission before replaying or voiding this order.',
          forbiddenAction:
            'Do not delete this pending ack silently; it is evidence for a possible cross-j state divergence.',
        },
      };
      pendingAck.ttlExpiredAt = now;
      queueCrossJFillAckIncidentEffect(candidateEffects, 'securityIncidentRecord', currentEntityState, pendingAck);
      entityLog.warn('crossj.fill_ack_ttl_expired_preserved', payload);
    }
    const account = currentEntityState.accounts.get(pendingAck.accountId);
    if (!account?.state.swapOffers?.has(pendingAck.tx.data.offerId)) continue;
    if (await admitGeneratedAccountTx(accountConsensusContext, currentEntityState, account, pendingAck.tx)) {
      appendCrossJurisdictionTargetProgressAfterAdmission(currentEntityState, pendingAck.tx, outputs);
      proposableAccounts.add(pendingAck.accountId);
      storageChanges.push({
        family: 'account',
        entityId: currentEntityState.entityId,
        counterpartyId: pendingAck.accountId,
      });
    }
    if (pendingAck.ttlExpiredAt !== undefined) {
      queueCrossJFillAckIncidentEffect(candidateEffects, 'securityIncidentResolve', currentEntityState, pendingAck);
    }
    pending.delete(key);
    drained++;
    entityLog.info('crossj.fill_ack_drained', {
      entity: shortId(currentEntityState.entityId, 8),
      account: shortId(pendingAck.accountId, 8),
      offer: shortOrder(pendingAck.tx.data.offerId, 8),
      storedAt: pendingAck.storedAt,
    });
  }
  return drained;
};

export const drainCommittedCrossJurisdictionCancelAcks = async (
  accountConsensusContext: AccountConsensusContext,
  currentEntityState: EntityState,
  proposableAccounts: Set<string>,
  storageChanges: RuntimeOverlayRecord[],
  outputs: EntityOutput[],
): Promise<number> => {
  let queued = 0;
  for (const { accountId, tx } of collectCommittedCrossJurisdictionCancelAcks(currentEntityState)) {
    if (tx.type !== 'cross_swap_fill_ack') {
      throw new Error(`CROSS_J_CANCEL_ACK_TX_INVALID:account=${accountId}:type=${tx.type}`);
    }
    const account = currentEntityState.accounts.get(accountId);
    if (!account) {
      throw new Error(`CROSS_J_CANCEL_ACK_ACCOUNT_MISSING:account=${accountId}:offer=${tx.data.offerId}`);
    }
    if (!(await admitGeneratedAccountTx(accountConsensusContext, currentEntityState, account, tx))) continue;
    appendCrossJurisdictionTargetProgressAfterAdmission(currentEntityState, tx, outputs);
    proposableAccounts.add(accountId);
    storageChanges.push({
      family: 'account',
      entityId: currentEntityState.entityId,
      counterpartyId: accountId,
    });
    queued += 1;
  }
  return queued;
};
import { applyAccountInput } from '../../account/consensus';
import type { AccountConsensusContext } from '../../account/consensus/context';
import { createLocalAccountInput } from '../../account/input';
import {
  buildCrossJurisdictionFillId,
  buildCrossJurisdictionFillNoticeTx,
  CROSS_J_PENDING_FILL_ACK_TTL_MS,
} from '../../extensions/cross-j/fill-ack';
import { cloneCrossJurisdictionAccountTxRoute } from '../../extensions/cross-j';
import { shortId, shortOrder } from '../../infra/logger';
import {
  findCrossJurisdictionBookAdmissionForAck,
  normalizeEntityRef,
} from '../../orderbook/cross-j-orderbook';
import { compareStableText } from '../../protocol/serialization';
import type { AccountReplica, AccountTx, RuntimeOverlayRecord } from '../../types/account';
import { collectCommittedCrossJurisdictionCancelAcks } from '../tx/handlers/account';
import type { EntityRuntimeContext } from '../runtime-context';
import type { EntityCandidateEffect, EntityInput, EntityOutput, EntityState } from '../types';
import { appendCrossJurisdictionTargetProgressAfterAdmission } from '../tx/cross-j-outputs';
import { entityLog } from './entity-log';

export { CROSS_J_PENDING_FILL_ACK_TTL_MS } from '../../extensions/cross-j/fill-ack';

type CrossSwapFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;

export const MAX_PENDING_CROSS_J_FILL_ACKS = 1024;
