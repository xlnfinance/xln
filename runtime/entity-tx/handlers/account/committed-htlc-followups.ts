import type {
  AccountInput,
  AccountMachine,
  AccountTx,
  EntityInput,
  EntityState,
  Env,
  HtlcNoteKey,
  HtlcRoute,
} from '../../../types';
import { HTLC } from '../../../constants';
import { HEAVY_LOGS } from '../../../utils';
import { NobleCryptoProvider } from '../../../crypto-noble';
import { unwrapEnvelope, validateEnvelope } from '../../../htlc-envelope-types';
import { terminateHtlcRoute } from '../../htlc-route-lifecycle';
import { sanitizeBaseFee } from '../../../routing/fees';
import { markStorageEntityDirty } from '../../../env-events';
import { scheduleHook as scheduleCrontabHook, HTLC_SECRET_ACK_TIMEOUT_MS } from '../../../entity-crontab';
import { resolveEntityProposerId } from '../../../state-helpers';
import {
  buildHtlcFinalizedEventPayload,
  buildHtlcReceivedEventPayload,
} from '../../../htlc-events';
import type { MempoolOp } from './orderbook-queue';

type HtlcFollowupContext = {
  env: Env;
  state: EntityState;
  newState: EntityState;
  input: AccountInput;
  accountMachine: AccountMachine;
  outputs: EntityInput[];
  mempoolOps: MempoolOp[];
};

type RevealedSecret = { secret: string; hashlock: string };

const getJurisdictionId = (state: EntityState, env: Env): string => {
  return String(state.config?.jurisdiction?.name || env.activeJurisdiction || '').trim();
};

const inboundEntityFor = (state: EntityState, accountMachine: AccountMachine): string =>
  state.entityId === accountMachine.leftEntity ? accountMachine.rightEntity : accountMachine.leftEntity;

async function decryptCommittedEnvelope(
  ctx: HtlcFollowupContext,
  lockId: string,
  envelopeData: string,
  reason: string,
): Promise<string> {
  const { env, state, input, newState } = ctx;
  if (envelopeData.trimStart().startsWith('{')) {
    env.error('network', 'MISSING_CRYPTO_KEY', {
      lockId,
      reason,
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
    }, state.entityId);
    throw new Error(`MISSING_CRYPTO_KEY:${lockId}`);
  }
  if (!newState.entityEncPrivKey) {
    env.error('network', 'MISSING_CRYPTO_KEY', {
      lockId,
      reason: 'missing_entity_encryption_key',
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
    }, state.entityId);
    throw new Error(`MISSING_CRYPTO_KEY:${lockId}`);
  }
  return new NobleCryptoProvider().decrypt(envelopeData, newState.entityEncPrivKey);
}

export async function applyCommittedHtlcLockFollowup(
  ctx: HtlcFollowupContext,
  accountTx: AccountTx,
  committedViaNewFrame: boolean,
): Promise<void> {
  if (accountTx.type !== 'htlc_lock') return;
  const { env, state, input, newState, accountMachine, mempoolOps } = ctx;

  if (!committedViaNewFrame) return;
  const lock = accountMachine.locks.get(accountTx.data.lockId);
  if (!lock?.envelope) return;

  let envelope = lock.envelope;
  try {
    if (typeof envelope === 'string') {
      envelope = unwrapEnvelope(
        await decryptCommittedEnvelope(ctx, lock.lockId, envelope, 'cleartext_direct_envelope'),
      );
    } else if (envelope.innerEnvelope && !envelope.finalRecipient) {
      envelope = unwrapEnvelope(
        await decryptCommittedEnvelope(ctx, lock.lockId, envelope.innerEnvelope, 'cleartext_inner_envelope'),
      );
    }
  } catch (error) {
    env.error('network', 'ENVELOPE_DECRYPT_FAIL', {
      lockId: lock.lockId,
      reason: error instanceof Error ? error.message : String(error),
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
    }, state.entityId);
    throw new Error(`ENVELOPE_DECRYPT_FAIL:${lock.lockId}`);
  }

  try {
    validateEnvelope(envelope);
  } catch {
    return;
  }
  if (
    lock.amount.toString() !== accountTx.data.amount.toString() ||
    lock.tokenId !== accountTx.data.tokenId ||
    lock.hashlock !== accountTx.data.hashlock
  ) {
    if (lock.hashlock !== accountTx.data.hashlock) {
      env.error('consensus', 'HTLC_ENVELOPE_HASHLOCK_MISMATCH', {
        lockId: lock.lockId,
        lockHashlock: lock.hashlock,
        txHashlock: accountTx.data.hashlock,
        fromEntityId: input.fromEntityId,
        toEntityId: input.toEntityId,
      }, state.entityId);
    }
    return;
  }
  if (envelope.nextHop && !envelope.finalRecipient && !newState.accounts.has(envelope.nextHop)) return;

  if (envelope.finalRecipient) {
    if (!envelope.secret) return;
    const inboundEntity = inboundEntityFor(newState, accountMachine);
    const paymentDescription = typeof envelope.description === 'string' ? envelope.description.trim() : '';
    if (!newState.htlcRoutes.has(lock.hashlock)) {
      newState.htlcRoutes.set(lock.hashlock, {
        hashlock: lock.hashlock,
        tokenId: lock.tokenId,
        amount: lock.amount,
        ...(typeof envelope.startedAtMs === 'number' ? { startedAtMs: envelope.startedAtMs } : {}),
        inboundEntity,
        inboundLockId: lock.lockId,
        createdTimestamp: newState.timestamp,
      });
    }
    env.emit('HtlcReceived', {
      ...buildHtlcReceivedEventPayload({
        entityId: state.entityId,
        fromEntity: input.fromEntityId,
        toEntity: state.entityId,
        hashlock: lock.hashlock,
        lockId: lock.lockId,
        amount: lock.amount,
        tokenId: lock.tokenId,
        ...(paymentDescription ? { description: paymentDescription } : {}),
        ...(typeof envelope.startedAtMs === 'number' ? { startedAtMs: envelope.startedAtMs } : {}),
        ...(getJurisdictionId(state, env) ? { jurisdictionId: getJurisdictionId(state, env) } : {}),
        receivedAtMs: newState.timestamp,
      }),
    });
    if (paymentDescription) {
      if (!(newState.htlcNotes instanceof Map)) newState.htlcNotes = new Map<HtlcNoteKey, string>();
      newState.htlcNotes.set(`hashlock:${lock.hashlock}`, paymentDescription);
      newState.htlcNotes.set(`lock:${lock.lockId}`, paymentDescription);
    }
    mempoolOps.push({
      accountId: input.fromEntityId,
      tx: { type: 'htlc_resolve', data: { lockId: lock.lockId, outcome: 'secret' as const, secret: envelope.secret } },
    });
    return;
  }

  if (!envelope.nextHop) return;
  const nextHop = envelope.nextHop;
  const inboundEntity = inboundEntityFor(newState, accountMachine);
  const htlcRoute: HtlcRoute = {
    hashlock: lock.hashlock,
    tokenId: lock.tokenId,
    amount: lock.amount,
    ...(typeof envelope.startedAtMs === 'number' ? { startedAtMs: envelope.startedAtMs } : {}),
    inboundEntity,
    inboundLockId: lock.lockId,
    outboundEntity: nextHop,
    outboundLockId: `${lock.lockId}-fwd`,
    createdTimestamp: newState.timestamp,
  };
  newState.htlcRoutes.set(lock.hashlock, htlcRoute);

  const cancelInboundLock = (reason: string) => {
    mempoolOps.push({
      accountId: input.fromEntityId,
      tx: { type: 'htlc_resolve', data: { lockId: lock.lockId, outcome: 'error' as const, reason } },
    });
    newState.htlcRoutes.delete(lock.hashlock);
  };
  if (!newState.accounts.has(nextHop)) {
    cancelInboundLock(`no_account:${nextHop.slice(-4)}`);
    return;
  }

  const localEntityId = String(newState.entityId || '').toLowerCase();
  const localProfile = env.gossip?.getProfiles?.()?.find((p: { entityId?: unknown; metadata?: { baseFee?: bigint } } | undefined) =>
    String(p?.entityId || '').toLowerCase() === localEntityId
  );
  const baseFee = sanitizeBaseFee(localProfile?.metadata?.baseFee ?? 0n);
  const envelopeForwardAmountRaw = (envelope as { forwardAmount?: unknown })?.forwardAmount;
  if (typeof envelopeForwardAmountRaw !== 'string' || envelopeForwardAmountRaw.length === 0) {
    cancelInboundLock('missing_forward_amount');
    return;
  }

  let forwardAmount: bigint;
  try {
    forwardAmount = BigInt(envelopeForwardAmountRaw);
  } catch {
    cancelInboundLock('invalid_forward_amount');
    return;
  }
  if (forwardAmount <= 0n || forwardAmount > lock.amount) {
    cancelInboundLock('invalid_forward_amount');
    return;
  }
  const feeAmount = lock.amount - forwardAmount;
  if (feeAmount < baseFee) {
    cancelInboundLock('fee_below_base');
    return;
  }

  htlcRoute.pendingFee = feeAmount;
  const forwardTimelock = lock.timelock - BigInt(HTLC.MIN_TIMELOCK_DELTA_MS);
  const forwardHeight = lock.revealBeforeHeight - 1;
  const currentJHeight = newState.lastFinalizedJHeight || 0;
  const safetyMarginMs = 1000;
  if (forwardTimelock < BigInt(newState.timestamp) + BigInt(safetyMarginMs)) {
    cancelInboundLock('timelock_too_tight');
    return;
  }
  if (forwardHeight <= currentJHeight) {
    cancelInboundLock('height_expired');
    return;
  }

  mempoolOps.push({
    accountId: nextHop,
    tx: {
      type: 'htlc_lock',
      data: {
        lockId: `${lock.lockId}-fwd`,
        hashlock: lock.hashlock,
        timelock: forwardTimelock,
        revealBeforeHeight: forwardHeight,
        amount: forwardAmount,
        tokenId: lock.tokenId,
        envelope: envelope.innerEnvelope,
      },
    },
  });
}

export function applyPendingForwardFollowup(ctx: HtlcFollowupContext): void {
  const { state, accountMachine, newState, mempoolOps } = ctx;
  if (!accountMachine.pendingForward || ctx.env.skipPendingForward) return;
  const forward = accountMachine.pendingForward;
  const nextHop = forward.route.length > 1 ? forward.route[1] : null;
  if (nextHop && newState.accounts.has(nextHop)) {
    mempoolOps.push({
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
        },
      },
    });
  }
  delete accountMachine.pendingForward;
}

export function applyHtlcTimeoutFollowups(ctx: HtlcFollowupContext, timedOutHashlocks: string[]): void {
  const { env, state, newState, mempoolOps } = ctx;
  for (const timedOutHashlock of timedOutHashlocks) {
    const route = newState.htlcRoutes.get(timedOutHashlock);
    if (!route) continue;
    if (route.inboundEntity && route.inboundLockId) {
      mempoolOps.push({
        accountId: route.inboundEntity,
        tx: {
          type: 'htlc_resolve',
          data: { lockId: route.inboundLockId, outcome: 'error' as const, reason: 'downstream_error' },
        },
      });
    } else {
      env.emit('HtlcFailed', {
        hashlock: timedOutHashlock,
        reason: 'timeout',
        entityId: state.entityId,
      });
    }
    if (route.outboundLockId) newState.lockBook.delete(route.outboundLockId);
    newState.htlcRoutes.delete(timedOutHashlock);
  }
}

export function applyHtlcSecretFollowups(ctx: HtlcFollowupContext, revealedSecrets: RevealedSecret[]): void {
  const { env, state, newState, outputs, mempoolOps } = ctx;
  if (HEAVY_LOGS) console.log(`HTLC-SECRET-CHECK: ${revealedSecrets.length} secrets revealed in frame`);

  for (const { secret, hashlock } of revealedSecrets) {
    const route = newState.htlcRoutes.get(hashlock);
    if (!route) continue;
    if (route.secret) continue;
    const outboundLock = route.outboundLockId ? newState.lockBook.get(route.outboundLockId) : undefined;
    const inboundLock = route.inboundLockId ? newState.lockBook.get(route.inboundLockId) : undefined;
    const eventLock = inboundLock ?? outboundLock;
    const eventAmount = eventLock?.amount ?? route.amount;
    const eventTokenId = eventLock?.tokenId ?? route.tokenId;
    const eventLockId = eventLock?.lockId ?? route.inboundLockId ?? route.outboundLockId;
    const finalizedDescription =
      (eventLock && newState.htlcNotes?.get(`lock:${eventLock.lockId}` as HtlcNoteKey))
      ?? newState.htlcNotes?.get(`hashlock:${hashlock}` as HtlcNoteKey)
      ?? undefined;

    route.secret = secret;
    if (route.pendingFee) {
      newState.htlcFeesEarned = (newState.htlcFeesEarned || 0n) + route.pendingFee;
      delete route.pendingFee;
    }
    if (route.outboundLockId) newState.lockBook.delete(route.outboundLockId);
    if (route.inboundLockId) newState.lockBook.delete(route.inboundLockId);

    if (route.inboundEntity && route.inboundLockId) {
      mempoolOps.push({
        accountId: route.inboundEntity,
        tx: { type: 'htlc_resolve', data: { lockId: route.inboundLockId, outcome: 'secret' as const, secret } },
      });
      route.secretAckPending = true;
      route.secretAckStartedAt = newState.timestamp;
      route.secretAckDeadlineAt = newState.timestamp + HTLC_SECRET_ACK_TIMEOUT_MS;
      if (newState.crontabState) {
        scheduleCrontabHook(newState.crontabState, {
          id: `htlc-secret-ack:${hashlock}`,
          triggerAt: route.secretAckDeadlineAt,
          type: 'htlc_secret_ack_timeout',
          data: {
            hashlock,
            counterpartyEntityId: route.inboundEntity,
            inboundLockId: route.inboundLockId,
          },
        });
        markStorageEntityDirty(env, newState.entityId);
      }
      continue;
    }

    if (route.crossJurisdictionRelay) {
      const relay = route.crossJurisdictionRelay;
      outputs.push({
        entityId: relay.targetEntityId,
        signerId: resolveEntityProposerId(ctx.env, relay.targetEntityId, 'htlc.cross-j-relay.resolve'),
        entityTxs: [{
          type: 'resolveHtlcLock',
          data: {
            counterpartyEntityId: relay.targetCounterpartyEntityId,
            lockId: relay.targetLockId,
            secret,
            description: `Cross-j ${relay.routeId} target claim ${relay.fillRatio}/65535`,
          },
        }],
      });
    }
    terminateHtlcRoute(newState, hashlock, newState.timestamp);
    env.emit('HtlcFinalized', {
      ...buildHtlcFinalizedEventPayload({
        entityId: state.entityId,
        fromEntity: state.entityId,
        ...(route.outboundEntity ? { toEntity: route.outboundEntity } : {}),
        hashlock,
        secret,
        ...(eventLockId ? { lockId: eventLockId } : {}),
        ...(eventAmount !== undefined ? { amount: eventAmount } : {}),
        ...(eventTokenId !== undefined ? { tokenId: eventTokenId } : {}),
        ...(finalizedDescription ? { description: finalizedDescription } : {}),
        ...(route.startedAtMs !== undefined ? { startedAtMs: route.startedAtMs } : {}),
        ...(getJurisdictionId(state, env) ? { jurisdictionId: getJurisdictionId(state, env) } : {}),
        finalizedAtMs: newState.timestamp,
      }),
    });
  }
}
