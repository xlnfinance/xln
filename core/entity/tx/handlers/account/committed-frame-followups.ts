import type { AccountFrame, AccountTx } from '../../../../types/account';
import type { EntityCandidateEffect, EntityState, PaybookEntry } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import { HEAVY_LOGS } from '../../../../support/debug-flags';
import { cancelHook } from '../../../scheduler';
import { terminatePayment } from '../../../paybook/lifecycle';
import { buildHtlcFinalizedEventPayload, buildHtlcReceivedEventPayload } from '../../../../protocol/htlc/events';
import { createStructuredLogger } from '../../../../support/logger';
import { hashHtlcSecret } from '../../../../protocol/htlc/utils';
import type { AccountTxTarget } from './orderbook/queue';
import { applyCommittedLendingFollowup } from './committed-lending-followup';
import { getEntityAccountForWrite } from '../../../state/persistent-account-map';
import { getEntityCollectionValueForWrite } from '../../../state/persistent-collection-map';
import {
  hasInboundPayment,
  isForwardingPayment,
} from '../../../paybook/views';

const accountFollowupLog = createStructuredLogger('account.followup');

const jurisdictionIdFor = (state: EntityState, env?: EntityRuntimeContext): string =>
  String(state.config?.jurisdiction?.name || env?.activeJurisdiction || '').trim();

function emitOriginatedHtlcFinalized(
  env: EntityRuntimeContext | undefined,
  state: EntityState,
  route: PaybookEntry,
  accountTx: Extract<AccountTx, { type: 'htlc_resolve' }>,
  candidateEffects: EntityCandidateEffect[],
): void {
  if (accountTx.data.outcome !== 'secret') return;
  if ((!route.originated && hasInboundPayment(route)) || route.hashlock !== accountTx.data.lockId) return;
  candidateEffects.push({
    kind: 'runtimeEvent',
    eventName: 'HtlcFinalized',
    data: buildHtlcFinalizedEventPayload({
      entityId: state.entityId,
      fromEntity: state.entityId,
      ...(route.outboundEntity ? { toEntity: route.outboundEntity } : {}),
      hashlock: route.hashlock,
      ...('secret' in accountTx.data ? { secret: accountTx.data.secret } : {}),
      lockId: accountTx.data.lockId,
      ...(route.amount !== undefined ? { amount: route.amount } : {}),
      ...(route.tokenId !== undefined ? { tokenId: route.tokenId } : {}),
      ...(route.startedAtMs !== undefined ? { startedAtMs: route.startedAtMs } : {}),
      ...(route.description ? { description: route.description } : {}),
      ...(jurisdictionIdFor(state, env) ? { jurisdictionId: jurisdictionIdFor(state, env) } : {}),
      finalizedAtMs: state.timestamp,
    }),
  });
}

const applyCommittedHtlcResolveFollowup = (
  newState: EntityState,
  counterpartyId: string,
  accountTx: Extract<AccountTx, { type: 'htlc_resolve' }>,
  env: EntityRuntimeContext | undefined,
  candidateEffects: EntityCandidateEffect[],
): void => {
  const visible = newState.accounts.get(counterpartyId);
  if (visible?.mempool?.length) {
    const account = getEntityAccountForWrite(newState.accounts, counterpartyId);
    if (!account) throw new Error(`HTLC_FOLLOWUP_WRITE_ACCOUNT_MISSING:${counterpartyId}`);
    account.mempool = account.mempool.filter((mempoolTx) =>
      !(mempoolTx.type === 'htlc_lock' && mempoolTx.data.lockId === accountTx.data.lockId)
    );
  }
  if (newState.crontabState) cancelHook(newState.crontabState, `htlc-timeout:${accountTx.data.lockId}`);
  if (accountTx.data.outcome !== 'secret') return;

  // Account already verified hashHtlcSecret(secret) against the lock. Routes
  // are keyed by that hash, so this is one direct lookup, never a route scan.
  const hashlock = hashHtlcSecret(accountTx.data.secret);
  if (hashlock !== accountTx.data.lockId.toLowerCase()) {
    throw new Error(`PAYBOOK_RESOLVE_ID_MISMATCH:${accountTx.data.lockId}:${hashlock}`);
  }
  const route = newState.paybook.entries.get(hashlock);
  if (!route) return;
  const normalizedCounterparty = counterpartyId.toLowerCase();
  const resolvesInbound = route.inboundEntity?.toLowerCase() === normalizedCounterparty;
  const resolvesOriginatedOutbound = route.outboundEntity?.toLowerCase() === normalizedCounterparty
    && (route.originated || !hasInboundPayment(route));
  const resolvesForwardedOutbound = route.outboundEntity?.toLowerCase() === normalizedCounterparty
    && isForwardingPayment(route) && !route.originated;
  if (!resolvesInbound && !resolvesOriginatedOutbound && !resolvesForwardedOutbound) return;
  if (resolvesInbound) {
    candidateEffects.push({
      kind: 'runtimeEvent',
      eventName: 'HtlcReceived',
      data: buildHtlcReceivedEventPayload({
        entityId: newState.entityId,
        fromEntity: counterpartyId,
        toEntity: newState.entityId,
        hashlock,
        lockId: accountTx.data.lockId,
        ...(route.amount !== undefined ? { amount: route.amount } : {}),
        ...(route.tokenId !== undefined ? { tokenId: route.tokenId } : {}),
        ...(route.startedAtMs !== undefined ? { startedAtMs: route.startedAtMs } : {}),
        ...(route.description ? { description: route.description } : {}),
        ...(jurisdictionIdFor(newState, env) ? { jurisdictionId: jurisdictionIdFor(newState, env) } : {}),
        receivedAtMs: newState.timestamp,
      }),
    });
  }
  // Propagation still needs the inbound lock reference; the secret followup
  // terminates this route after it queues the upstream resolve.
  if (resolvesForwardedOutbound) return;
  emitOriginatedHtlcFinalized(env, newState, route, accountTx, candidateEffects);
  if (route.originated && route.inboundEntity) {
    const writableRoute = getEntityCollectionValueForWrite(newState.paybook.entries, hashlock);
    if (!writableRoute) throw new Error(`PAYBOOK_ENTRY_WRITE_MISSING:${hashlock}`);
    if (resolvesInbound) writableRoute.inboundSettled = true;
    if (resolvesOriginatedOutbound) writableRoute.outboundSettled = true;
    if (!writableRoute.inboundSettled || !writableRoute.outboundSettled) return;
  }
  terminatePayment(newState, hashlock);
};

export function applyCommittedAccountFrameFollowups(
  newState: EntityState,
  counterpartyId: string,
  committedFrame: AccountFrame,
  proposerIsLeft: boolean,
  accountTxs: AccountTxTarget[],
  env: EntityRuntimeContext | undefined,
  candidateEffects: EntityCandidateEffect[],
): void {
  if (HEAVY_LOGS) {
    accountFollowupLog.debug('frame.commit', {
      height: committedFrame.height,
      txs: committedFrame.accountTxs.length,
    });
  }

  for (const accountTx of committedFrame.accountTxs) {
    if (HEAVY_LOGS) accountFollowupLog.debug('frame.tx', { type: accountTx.type });
    applyCommittedLendingFollowup(
      newState,
      counterpartyId,
      accountTx,
      committedFrame,
      proposerIsLeft,
      accountTxs,
    );

    // Account frames are canonical once committed; update Entity-local
    // indexes only after commit, never while the proposal is tentative.
    if (accountTx.type === 'htlc_resolve') {
      applyCommittedHtlcResolveFollowup(newState, counterpartyId, accountTx, env, candidateEffects);
    }
  }
}
