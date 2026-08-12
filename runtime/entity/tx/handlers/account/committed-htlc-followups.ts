import type { AccountPeerInput, AccountReplica, AccountTx } from '../../../../types/account';
import type { EntityCandidateEffect, EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import { HEAVY_LOGS } from '../../../../infra/debug-flags';
import {
  validateLocalCommittedHtlcLayer,
} from '../../../htlc/onion-advance';
import { encryptedHtlcLayer } from '../../../../protocol/htlc/codec/onion-layer';
import {
  armHtlcSecretAckTimeout,
  terminateHtlcRoute,
} from '../../htlc-route-lifecycle';
import { pushCrossJurisdictionEntityOutput } from '../../cross-j-outputs';
import { CROSS_J_MAX_FILL_RATIO } from '../../../../extensions/cross-j/index';
import { buildHtlcFinalizedEventPayload } from '../../../../protocol/htlc/events';
import { createStructuredLogger } from '../../../../infra/logger';
import type { AccountTxTarget } from './orderbook-queue';
import { MalformedEntityFrameInputError } from '../../invariant-errors';

const accountFollowupLog = createStructuredLogger('account.followup');

type HtlcFollowupContext = {
  env: EntityRuntimeContext;
  state: EntityState;
  newState: EntityState;
  input: AccountPeerInput;
  account: AccountReplica;
  outputs: EntityInput[];
  accountTxs: AccountTxTarget[];
  candidateEffects: EntityCandidateEffect[];
};

type RevealedSecret = { secret: string; hashlock: string };
type HtlcSecretFollowupContext = Pick<
  HtlcFollowupContext,
  'env' | 'state' | 'newState' | 'outputs' | 'accountTxs' | 'candidateEffects'
>;

const getJurisdictionId = (state: EntityState, env: EntityRuntimeContext): string =>
  String(state.config?.jurisdiction?.name || env.activeJurisdiction || '').trim();

/**
 * Consensus replay validates only the public ciphertext and its certified
 * default-proposer recipient. Plaintext decryption is a post-commit local hook
 * which emits a signed htlcOnionAdvance for the next Entity frame.
 */
export async function applyCommittedHtlcLockFollowup(
  ctx: HtlcFollowupContext,
  accountTx: AccountTx,
  _committedViaNewFrame: boolean,
): Promise<void> {
  if (accountTx.type !== 'htlc_lock') return;
  const { env, state, input, newState, account } = ctx;
  const lock = account.state.locks.get(accountTx.data.lockId);
  if (!lock || accountTx.data.envelope === undefined) return;
  const layer = encryptedHtlcLayer(accountTx.data.envelope);
  if (!layer) throw new Error(`HTLC_ONION_ENCRYPTED_LAYER_REQUIRED:${lock.lockId}`);
  if (layer.manifest.entityId.toLowerCase() !== newState.entityId.toLowerCase()) return;
  try {
    await validateLocalCommittedHtlcLayer(env, newState, lock, accountTx.data.envelope);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    env.error('network', 'HTLC_ONION_PUBLIC_VALIDATION_FAILED', {
      lockId: lock.lockId,
      reason,
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
    }, state.entityId);
    throw new Error(`HTLC_ONION_PUBLIC_VALIDATION_FAILED:${lock.lockId}:${reason}`);
  }
}

export function applyPendingForwardFollowup(ctx: HtlcFollowupContext): void {
  const { state, account, newState, accountTxs } = ctx;
  const forwards = account.pendingForwards;
  if (!forwards?.length) return;

  for (const [forwardIndex, forward] of forwards.entries()) {
    const nextHop = forward.route.length > 1 ? forward.route[1] : undefined;
    if (!nextHop) {
      throw new Error(`ROUTED_PAYMENT_NEXT_HOP_MISSING:index=${forwardIndex}`);
    }
    if (!newState.accounts.has(nextHop)) {
      throw new MalformedEntityFrameInputError(
        'accountInput',
        `ROUTED_PAYMENT_NEXT_HOP_ACCOUNT_MISSING:index=${forwardIndex}:nextHop=${nextHop}`,
      );
    }
    accountTxs.push({
      accountId: nextHop,
      tx: {
        type: 'direct_payment',
        data: {
          tokenId: forward.tokenId,
          amount: forward.amount,
          route: forward.route.slice(1),
          description: forward.description || 'Forwarded payment',
          fromEntityId: state.entityId,
          toEntityId: nextHop,
          deliveryMode: forward.deliveryMode,
          trustedGatewayEntityId: forward.trustedGatewayEntityId,
        },
      },
    });
  }
  delete account.pendingForwards;
}

export function applyHtlcTimeoutFollowups(ctx: HtlcFollowupContext, timedOutHashlocks: string[]): void {
  const { state, newState, accountTxs, candidateEffects } = ctx;
  for (const timedOutHashlock of timedOutHashlocks) {
    const route = newState.htlcRoutes.get(timedOutHashlock);
    if (!route) continue;
    if (route.inboundEntity && route.inboundLockId) {
      accountTxs.push({
        accountId: route.inboundEntity,
        tx: {
          type: 'htlc_resolve',
          data: { lockId: route.inboundLockId, outcome: 'error', reason: 'downstream_error' },
        },
      });
    } else {
      candidateEffects.push({
        kind: 'runtimeEvent',
        eventName: 'HtlcFailed',
        data: {
          hashlock: timedOutHashlock,
          ...(route.outboundLockId ? { lockId: route.outboundLockId } : {}),
          reason: 'timeout',
          entityId: state.entityId,
        },
      });
    }
    if (route.outboundLockId) newState.lockBook.delete(route.outboundLockId);
    terminateHtlcRoute(newState, timedOutHashlock, newState.timestamp);
  }
}

export function applyHtlcSecretFollowups(ctx: HtlcSecretFollowupContext, revealedSecrets: RevealedSecret[]): void {
  const { env, state, newState, outputs, accountTxs, candidateEffects } = ctx;
  if (HEAVY_LOGS) accountFollowupLog.debug('htlc.secret_check', { secrets: revealedSecrets.length });

  for (const { secret, hashlock } of revealedSecrets) {
    const route = newState.htlcRoutes.get(hashlock);
    if (!route || route.secret) continue;
    const outboundLock = route.outboundLockId ? newState.lockBook.get(route.outboundLockId) : undefined;
    const inboundLock = route.inboundLockId ? newState.lockBook.get(route.inboundLockId) : undefined;
    const eventLock = inboundLock ?? outboundLock;
    const eventAmount = eventLock?.amount ?? route.amount;
    const eventTokenId = eventLock?.tokenId ?? route.tokenId;
    const eventLockId = eventLock?.lockId ?? route.inboundLockId ?? route.outboundLockId;
    route.secret = secret;
    if (route.pendingFee) {
      newState.htlcFeesEarned = (newState.htlcFeesEarned || 0n) + route.pendingFee;
      delete route.pendingFee;
    }
    if (route.outboundLockId) newState.lockBook.delete(route.outboundLockId);
    if (route.inboundLockId) newState.lockBook.delete(route.inboundLockId);

    if (route.inboundEntity && route.inboundLockId) {
      accountTxs.push({
        accountId: route.inboundEntity,
        tx: { type: 'htlc_resolve', data: { lockId: route.inboundLockId, outcome: 'secret', secret } },
      });
      // Never also resolve an originated self-cycle's outbound lock here.
      // The same entity may be both route origin and terminal recipient, but
      // each intermediary must still learn the preimage from its committed
      // downstream Account frame and propagate it upstream. Closing the first
      // and last legs together would hide a broken middle-hop propagation path
      // and can leave asymmetric commitments across a crash or dispute.
      armHtlcSecretAckTimeout(newState, route);
      continue;
    }

    if (route.crossJurisdictionRelay) {
      const relay = route.crossJurisdictionRelay;
      pushCrossJurisdictionEntityOutput(outputs, relay.targetEntityId, [{
        type: 'resolveHtlcLock',
        data: {
          counterpartyEntityId: relay.targetCounterpartyEntityId,
          lockId: relay.targetLockId,
          secret,
          crossJurisdictionRouteId: relay.routeId,
          description: `Cross-j ${relay.routeId} target claim ${relay.fillRatio}/${CROSS_J_MAX_FILL_RATIO}`,
        },
      }], relay.targetSignerId);
    }
    terminateHtlcRoute(newState, hashlock, newState.timestamp);
    candidateEffects.push({
      kind: 'runtimeEvent',
      eventName: 'HtlcFinalized',
      data: buildHtlcFinalizedEventPayload({
        entityId: state.entityId,
        fromEntity: state.entityId,
        ...(route.outboundEntity ? { toEntity: route.outboundEntity } : {}),
        hashlock,
        secret,
        ...(eventLockId ? { lockId: eventLockId } : {}),
        ...(eventAmount !== undefined ? { amount: eventAmount } : {}),
        ...(eventTokenId !== undefined ? { tokenId: eventTokenId } : {}),
        ...(route.startedAtMs !== undefined ? { startedAtMs: route.startedAtMs } : {}),
        ...(getJurisdictionId(state, env) ? { jurisdictionId: getJurisdictionId(state, env) } : {}),
        finalizedAtMs: newState.timestamp,
      }),
    });
  }
}
