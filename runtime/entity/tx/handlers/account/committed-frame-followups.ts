import type { AccountFrame, AccountTx, HtlcRoute } from '../../../../types/account';
import type { EntityCandidateEffect, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import { HEAVY_LOGS } from '../../../../infra/debug-flags';
import { cancelHook } from '../../../scheduler';
import { pruneSettledOriginatedHtlcRoutes, terminateHtlcRoute } from '../../htlc-route-lifecycle';
import { buildHtlcFinalizedEventPayload, buildHtlcReceivedEventPayload } from '../../../../protocol/htlc/events';
import { createStructuredLogger } from '../../../../infra/logger';
import type { AccountTxTarget } from './orderbook/queue';
import { applyCommittedLendingFollowup } from './committed-lending-followup';

const accountFollowupLog = createStructuredLogger('account.followup');

const jurisdictionIdFor = (state: EntityState, env?: EntityRuntimeContext): string =>
  String(state.config?.jurisdiction?.name || env?.activeJurisdiction || '').trim();

function emitOriginatedHtlcFinalized(
  env: EntityRuntimeContext | undefined,
  state: EntityState,
  route: HtlcRoute,
  accountTx: Extract<AccountTx, { type: 'htlc_resolve' }>,
  candidateEffects: EntityCandidateEffect[],
): void {
  if (accountTx.data.outcome !== 'secret') return;
  if ((!route.originated && route.inboundEntity) || route.outboundLockId !== accountTx.data.lockId) return;
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
      ...(jurisdictionIdFor(state, env) ? { jurisdictionId: jurisdictionIdFor(state, env) } : {}),
      finalizedAtMs: state.timestamp,
    }),
  });
}

export function applyCommittedAccountFrameFollowups(
  newState: EntityState,
  counterpartyId: string,
  committedFrame: AccountFrame,
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
    applyCommittedLendingFollowup(newState, counterpartyId, accountTx, committedFrame, accountTxs);

    // Account frames are canonical once committed; keep entity-local indexes in
    // sync here instead of mutating them while the account proposal is still tentative.
    if (accountTx.type === 'htlc_resolve') {
      if (accountTx.data.outcome === 'offer') continue;
      const account = newState.accounts.get(counterpartyId);
      if (account?.mempool?.length) {
        account.mempool = account.mempool.filter((mempoolTx) =>
          !(mempoolTx.type === 'htlc_lock' && mempoolTx.data.lockId === accountTx.data.lockId)
        );
      }
      newState.lockBook.delete(accountTx.data.lockId);
      if (newState.crontabState) {
        cancelHook(newState.crontabState, `htlc-timeout:${accountTx.data.lockId}`);
      }
      if (accountTx.data.outcome === 'secret') {
        for (const [hashlock, route] of newState.htlcRoutes.entries()) {
          const resolvesInbound = route.inboundLockId === accountTx.data.lockId;
          const resolvesOriginatedOutbound =
            route.outboundLockId === accountTx.data.lockId && (route.originated || !route.inboundEntity);
          const resolvesForwardedOutbound =
            route.outboundLockId === accountTx.data.lockId && Boolean(route.inboundEntity) && !route.originated;
          if (!resolvesInbound && !resolvesOriginatedOutbound && !resolvesForwardedOutbound) continue;
          if ('offerHash' in accountTx.data) {
            if (resolvesForwardedOutbound || resolvesOriginatedOutbound) {
              route.acceptedOfferHash = accountTx.data.offerHash.toLowerCase();
              route.acceptedAccountFrameHash = committedFrame.stateHash.toLowerCase();
              route.acceptedAccountFrameHeight = committedFrame.height;
              continue;
            }
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
                  ...(jurisdictionIdFor(newState, env) ? { jurisdictionId: jurisdictionIdFor(newState, env) } : {}),
                  receivedAtMs: newState.timestamp,
                }),
              });
            }
          }
          if (resolvesForwardedOutbound) {
            // This commit reveals the downstream preimage, but the forwarded
            // route is not terminal until applyHtlcSecretFollowups queues the
            // exact upstream resolve in this same Entity-frame replay. Deleting
            // it here loses the inbound lock reference and lets the post-commit
            // onion hook recreate the downstream lock forever.
            continue;
          }
          emitOriginatedHtlcFinalized(env, newState, route, accountTx, candidateEffects);
          if (route.originated && route.inboundEntity) {
            if (resolvesInbound) route.inboundSettled = true;
            if (resolvesOriginatedOutbound) route.outboundSettled = true;
            if (!route.inboundSettled || !route.outboundSettled) continue;
          }
          terminateHtlcRoute(newState, hashlock, newState.timestamp);
        }
      }
    }

    if (accountTx.type === 'j_event_claim') continue;

  }
  pruneSettledOriginatedHtlcRoutes(newState, newState.timestamp);
}
