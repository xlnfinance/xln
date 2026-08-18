import type { AccountFrame, AccountTx, HtlcRoute } from '../../../../types/account';
import type { EntityCandidateEffect, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import { HEAVY_LOGS } from '../../../../support/debug-flags';
import { cancelHook } from '../../../scheduler';
import { terminateHtlcRoute } from '../../j-events-htlc/route-lifecycle';
import { buildHtlcFinalizedEventPayload, buildHtlcReceivedEventPayload } from '../../../../protocol/htlc/events';
import { createStructuredLogger } from '../../../../support/logger';
import { hashHtlcSecret } from '../../../../protocol/htlc/utils';
import type { AccountTxTarget } from './orderbook/queue';
import { applyCommittedLendingFollowup } from './committed-lending-followup';
import { getEntityAccountForWrite } from '../../../state/persistent-account-map';
import { getEntityCollectionValueForWrite } from '../../../state/persistent-collection-map';
import {
  hasInboundHtlcRoute,
  isForwardingHtlcRoute,
} from '../../../htlc/route-views';

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
  if ((!route.originated && hasInboundHtlcRoute(route)) || route.outboundLockId !== accountTx.data.lockId) return;
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
      const visible = newState.accounts.get(counterpartyId);
      if (visible?.mempool?.length) {
        const account = getEntityAccountForWrite(newState.accounts, counterpartyId);
        if (!account) throw new Error(`HTLC_FOLLOWUP_WRITE_ACCOUNT_MISSING:${counterpartyId}`);
        account.mempool = account.mempool.filter((mempoolTx) =>
          !(mempoolTx.type === 'htlc_lock' && mempoolTx.data.lockId === accountTx.data.lockId)
        );
      }
      newState.lockBook.delete(accountTx.data.lockId);
      if (newState.crontabState) {
        cancelHook(newState.crontabState, `htlc-timeout:${accountTx.data.lockId}`);
      }
      if (accountTx.data.outcome === 'secret') {
        // The account resolve handler already enforced
        // hashHtlcSecret(secret) === lock.hashlock, and routes are keyed by
        // hashlock, so the route this lock belongs to is a direct lookup.
        // Scanning every route per resolve was O(routes) per payment and
        // ~30% of Hub CPU at 500 users.
        const secretHashlock = hashHtlcSecret(accountTx.data.secret);
        const directRoute = newState.htlcRoutes.get(secretHashlock)
          ?? newState.htlcRoutes.get(secretHashlock.toLowerCase());
        // No route under that hashlock: fall back to the scan (legacy routes
        // keyed differently, or lock-only bookkeeping) so behaviour is unchanged.
        const matchedRoutes: Iterable<[string, HtlcRoute]> = directRoute
          ? [[newState.htlcRoutes.has(secretHashlock) ? secretHashlock : secretHashlock.toLowerCase(), directRoute]]
          : newState.htlcRoutes.entries();
        for (const [hashlock, route] of matchedRoutes) {
          const resolvesInbound = route.inboundLockId === accountTx.data.lockId;
          const resolvesOriginatedOutbound =
            route.outboundLockId === accountTx.data.lockId && (route.originated || !hasInboundHtlcRoute(route));
          const resolvesForwardedOutbound =
            route.outboundLockId === accountTx.data.lockId && isForwardingHtlcRoute(route) && !route.originated;
          if (!resolvesInbound && !resolvesOriginatedOutbound && !resolvesForwardedOutbound) continue;
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
          if (resolvesForwardedOutbound) {
            // This commit reveals the downstream preimage, but the forwarded
            // route is not terminal until applyHtlcSecretFollowups queues the
            // exact upstream resolve in this same Entity-frame replay. Deleting
            // it here loses the inbound lock reference needed for propagation.
            continue;
          }
          emitOriginatedHtlcFinalized(env, newState, route, accountTx, candidateEffects);
          if (route.originated && route.inboundEntity) {
            const writableRoute = getEntityCollectionValueForWrite(newState.htlcRoutes, hashlock);
            if (!writableRoute) throw new Error(`HTLC_ROUTE_WRITE_MISSING:${hashlock}`);
            if (resolvesInbound) writableRoute.inboundSettled = true;
            if (resolvesOriginatedOutbound) writableRoute.outboundSettled = true;
            if (!writableRoute.inboundSettled || !writableRoute.outboundSettled) continue;
          }
          terminateHtlcRoute(newState, hashlock, newState.timestamp);
        }
      }
    }

    if (accountTx.type === 'j_event_claim') continue;

  }
}
