import type {
  AccountFrame,
  AccountOutput,
  AccountPeerInput,
  AccountReplica,
  AccountTx,
  HtlcLock,
} from '../../../../types/account';
import type { EntityCandidateEffect, EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import { HEAVY_LOGS } from '../../../../support/debug-flags';
import { encryptedHtlcLayer, hashEncryptedHtlcLayer } from '../../../../protocol/htlc/codec/onion-layer';
import {
  armHtlcSecretAckTimeout,
  terminateHtlcRoute,
} from '../../j-events-htlc/route-lifecycle';
import { pushCrossJurisdictionEntityOutput } from '../../j-events-htlc/cross-j-outputs';
import { CROSS_J_MAX_FILL_RATIO } from '../../../../extensions/cross-j/index';
import { buildHtlcFinalizedEventPayload } from '../../../../protocol/htlc/events';
import { createStructuredLogger } from '../../../../support/logger';
import type { AccountTxTarget } from './orderbook/queue';
import { MalformedEntityFrameInputError } from '../../processing/invariant-errors';
import type { EntityInfraContext } from '../../../../types/entity/infra-context';
import { preparedHtlcBindingKey, type PreparedHtlcEntry } from '../../../../types/entity/htlc-infra-context';
import { HTLC } from '../../../../config/constants';
import { sameAccountStateDomain } from '../../../../account/commitment/state-root';
import { deriveForwardHtlcLockId } from '../../../../protocol/htlc/utils';
import { haltRuntimeFailure } from '../../../../protocol/errors/failure-taxonomy';
import { hasInboundHtlcRoute } from '../../../htlc/route-views';
import { getEntityCollectionValueForWrite } from '../../../state/persistent-collection-map';
import { countOp } from '../../../../support/performance/op-counters';

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
  infraContext?: EntityInfraContext;
  preparedHtlcEntriesByBinding?: ReadonlyMap<string, PreparedHtlcEntry>;
  consumedPreparedHtlcBindings?: Set<string>;
};

type RevealedSecret = { secret: string; hashlock: string };
type DirectPaymentForward = Extract<AccountOutput, { kind: 'directPaymentForward' }>;
type HtlcSecretFollowupContext = Pick<
  HtlcFollowupContext,
  'env' | 'state' | 'newState' | 'outputs' | 'accountTxs' | 'candidateEffects'
>;

const getJurisdictionId = (state: EntityState, env: EntityRuntimeContext): string =>
  String(state.config?.jurisdiction?.name || env.activeJurisdiction || '').trim();

const requirePreparedHtlcEntry = (
  ctx: HtlcFollowupContext,
  lock: HtlcLock,
  committedFrame: AccountFrame,
): PreparedHtlcEntry => {
  const envelopeHash = lock.envelopeHash?.toLowerCase();
  const prepared = ctx.infraContext && envelopeHash !== undefined
    ? ctx.preparedHtlcEntriesByBinding?.get(
        `${committedFrame.stateHash.toLowerCase()}:${lock.lockId.toLowerCase()}`,
      )
    : undefined;
  if (!prepared) throw new Error(`HTLC_PREPARED_CONTEXT_REQUIRED:${lock.lockId}`);
  const key = preparedHtlcBindingKey(prepared.binding);
  if (!ctx.consumedPreparedHtlcBindings) throw new Error('HTLC_PREPARED_CONSUMPTION_TRACKER_REQUIRED');
  if (ctx.consumedPreparedHtlcBindings.has(key)) throw new Error(`HTLC_PREPARED_CONTEXT_REUSED:${key}`);
  ctx.consumedPreparedHtlcBindings.add(key);
  const binding = prepared.binding;
  if (
    binding.fromEntityId !== ctx.input.fromEntityId.toLowerCase()
    || binding.toEntityId !== ctx.input.toEntityId.toLowerCase()
    || binding.accountHeight !== committedFrame.height
    || binding.envelopeHash !== envelopeHash
    || !sameAccountStateDomain(binding.domain, ctx.input.domain)
    || binding.hashlock !== lock.hashlock.toLowerCase()
    || binding.tokenId !== lock.tokenId
    || binding.amount !== lock.amount
    || binding.timelock !== lock.timelock
    || binding.revealBeforeHeight !== lock.revealBeforeHeight
  ) throw new Error(`HTLC_PREPARED_BINDING_MISMATCH:${lock.lockId}`);
  return prepared;
};

const applyPreparedHtlcOutcome = (
  ctx: HtlcFollowupContext,
  lock: HtlcLock,
  prepared: PreparedHtlcEntry,
): void => {
  const inboundEntity = ctx.input.fromEntityId.toLowerCase();
  const existingRoute = ctx.newState.htlcRoutes.get(lock.hashlock);
  const closesOriginatedSelfCycle = prepared.outcome.kind === 'final'
    && existingRoute?.originated === true
    && !hasInboundHtlcRoute(existingRoute);
  if ((existingRoute && !closesOriginatedSelfCycle) || prepared.outcome.kind === 'reject') {
    const reason = existingRoute
      ? 'hashlock_already_active'
      : prepared.outcome.kind === 'reject' ? prepared.outcome.reason : 'hashlock_already_active';
    ctx.accountTxs.push({ accountId: inboundEntity, tx: {
      type: 'htlc_resolve', data: { lockId: lock.lockId, outcome: 'error', reason },
    } });
    countOp(`htlc.inbound.reject.${reason}`);
    return;
  }
  if (prepared.outcome.kind === 'final') {
    if (closesOriginatedSelfCycle) {
      const writableRoute = getEntityCollectionValueForWrite(ctx.newState.htlcRoutes, lock.hashlock);
      if (!writableRoute) throw new Error(`HTLC_ROUTE_WRITE_MISSING:${lock.hashlock}`);
      writableRoute.inboundEntity = inboundEntity;
      writableRoute.inboundLockId = lock.lockId;
    } else {
      ctx.newState.htlcRoutes.set(lock.hashlock, {
        hashlock: lock.hashlock, tokenId: lock.tokenId, amount: lock.amount,
        ...(prepared.outcome.startedAtMs !== undefined ? { startedAtMs: prepared.outcome.startedAtMs } : {}),
        inboundEntity, inboundLockId: lock.lockId, createdTimestamp: ctx.newState.timestamp,
      });
    }
    ctx.accountTxs.push({ accountId: inboundEntity, tx: {
      type: 'htlc_resolve', data: { lockId: lock.lockId, outcome: 'secret', secret: prepared.outcome.secret },
    } });
    countOp('htlc.inbound.final');
    return;
  }
  const outboundLockId = deriveForwardHtlcLockId(lock.lockId);
  ctx.newState.htlcRoutes.set(lock.hashlock, {
    hashlock: lock.hashlock, tokenId: lock.tokenId, amount: lock.amount,
    inboundEntity, inboundLockId: lock.lockId,
    outboundEntity: prepared.outcome.nextHopEntityId, outboundLockId,
    pendingFee: lock.amount - prepared.outcome.forwardAmount,
    createdTimestamp: ctx.newState.timestamp,
  });
  ctx.candidateEffects.push({
    kind: 'runtimeEvent',
    eventName: 'HtlcForwardAccepted',
    data: { entityId: ctx.newState.entityId, hashlock: lock.hashlock },
  });
  ctx.accountTxs.push({ accountId: prepared.outcome.nextHopEntityId, tx: { type: 'htlc_lock', data: {
    lockId: outboundLockId, hashlock: lock.hashlock, tokenId: lock.tokenId,
    amount: prepared.outcome.forwardAmount,
    timelock: lock.timelock - BigInt(HTLC.MIN_TIMELOCK_DELTA_MS),
    revealBeforeHeight: lock.revealBeforeHeight - HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS,
    envelope: prepared.outcome.innerEnvelope,
  } } });
  countOp('htlc.inbound.forward');
};

/**
 * Account replay validates only canonical opaque bytes and their committed
 * hash. The owning Entity frame consumes its required prepared context in the
 * same transition; no post-commit forward action exists.
 */
export async function applyCommittedHtlcLockFollowup(
  ctx: HtlcFollowupContext,
  accountTx: AccountTx,
  committedFrame: AccountFrame,
  committedViaNewFrame: boolean,
): Promise<void> {
  if (accountTx.type !== 'htlc_lock') return;
  // Only the Entity receiving a peer proposal decrypts and advances the onion.
  // The proposer later replays the same frame on ACK solely to commit its own
  // outbound Account state; requiring recipient context there would execute the
  // payment twice and ask the sender to decrypt ciphertext addressed to its peer.
  if (!committedViaNewFrame) return;
  if (accountTx.data.envelope === undefined) return;
  const layer = encryptedHtlcLayer(accountTx.data.envelope);
  if (!layer) {
    throw haltRuntimeFailure(
      'HTLC_ONION_ENCRYPTED_LAYER_REQUIRED',
      `HTLC_ONION_ENCRYPTED_LAYER_REQUIRED:${accountTx.data.lockId}`,
    );
  }
  if (!Number.isSafeInteger(committedFrame.height) || committedFrame.height <= 0) {
    throw haltRuntimeFailure(
      'HTLC_COMMITTED_FRAME_HEIGHT_INVALID',
      `HTLC_COMMITTED_FRAME_HEIGHT_INVALID:${committedFrame.height}`,
    );
  }
  // The committed frame is the signed authority for this exact lock. Reading
  // it back from a mirrored Account body forced the Rust cutover to ship the
  // whole tree between its inbound and outbound visits. These fields are the
  // canonical lock constructor used by both engines; rejected locks never
  // appear in `frame.accountTxs`.
  const lock: HtlcLock = {
    lockId: accountTx.data.lockId,
    hashlock: accountTx.data.hashlock,
    timelock: accountTx.data.timelock,
    revealBeforeHeight: accountTx.data.revealBeforeHeight,
    amount: accountTx.data.amount,
    tokenId: accountTx.data.tokenId,
    senderIsLeft: committedFrame.byLeft,
    // The Account handler stamps the pre-proposal height. The containing
    // frame is exactly the next height (proposal/frame.ts); using the frame
    // height here would synthesize a different lock than either engine did.
    createdHeight: committedFrame.height - 1,
    createdTimestamp: committedFrame.timestamp,
    envelopeHash: hashEncryptedHtlcLayer(layer),
  };
  const prepared = requirePreparedHtlcEntry(ctx, lock, committedFrame);
  // A hashlock is the Entity-wide identity of one live routed payment. Without
  // this guard, a peer can commit a second lock through another Account and
  // replace the honest route below. The eventual preimage would then settle
  // the attacker's inbound lock while the honest upstream lock times out,
  // transferring the hub's outbound principal. The Account lock is already
  // committed, so reject only that colliding lock and preserve the first route.
  applyPreparedHtlcOutcome(ctx, lock, prepared);
}

export function applyDirectPaymentForwardFollowups(
  ctx: HtlcFollowupContext,
  forwards: readonly DirectPaymentForward[],
): void {
  const { state, newState, accountTxs } = ctx;
  if (forwards.length === 0) return;

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
}

export function applyHtlcTimeoutFollowups(ctx: HtlcFollowupContext, timedOutHashlocks: string[]): void {
  const { state, newState, accountTxs, candidateEffects } = ctx;
  for (const timedOutHashlock of timedOutHashlocks) {
    const route = newState.htlcRoutes.get(timedOutHashlock);
    if (!route) continue;
    if (hasInboundHtlcRoute(route)) {
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
    const route = getEntityCollectionValueForWrite(newState.htlcRoutes, hashlock);
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

    if (hasInboundHtlcRoute(route)) {
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
