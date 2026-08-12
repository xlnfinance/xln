/**
 * Deterministic Entity replay for an ingress-sealed HTLC payment.
 *
 * Route discovery and onion construction happen once at trusted local ingress.
 * The proposer keeps the preimage private. Validators independently verify
 * the public route, certified manifests, exact debit/fees, frozen deadlines,
 * and outer ciphertext bindings; frame hashes commit the opaque bytes exactly.
 */

import type { AccountState, AccountTx } from '../../../../types/account';
import type { EntityCandidateEffect, EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import { deriveDelta } from '../../../../account/utils';
import { validatePreparedHtlcPayment } from '../../../htlc/payment-admission';
import { createStructuredLogger, formatAmount, shortHash, shortId } from '../../../../infra/logger';

const htlcLog = createStructuredLogger('entity.htlc');
const formatEntityId = (id: string): string => id.slice(-4);
type PreparedHtlcPayment = Awaited<ReturnType<typeof validatePreparedHtlcPayment>>;
type HtlcPaymentResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs: Array<{ accountId: string; tx: AccountTx }>;
};

const rejectHtlcPayment = (
  newState: EntityState,
  message: string,
  logMessage: string,
): HtlcPaymentResult => {
  htlcLog.error('failed', { context: 'HTLC_PAYMENT', message: logMessage });
  addMessage(newState, message);
  return { newState, outputs: [], accountTxs: [] };
};

const recordFailedHtlc = (
  state: EntityState,
  prepared: PreparedHtlcPayment,
  effects: EntityCandidateEffect[],
  reason: 'next-hop-account-missing' | 'token-delta-missing' | 'insufficient-capacity',
): void => {
  effects.push({
    kind: 'runtimeEvent',
    eventName: 'HtlcFailed',
    data: {
      entityId: state.entityId,
      fromEntity: state.entityId,
      toEntity: prepared.targetEntityId,
      tokenId: prepared.tokenId,
      amount: prepared.recipientAmount.toString(),
      hashlock: prepared.hashlock,
      lockId: prepared.lockId,
      reason,
    },
  });
};

const requireOutboundCapacity = (
  newState: EntityState,
  prepared: PreparedHtlcPayment,
  candidateEffects: EntityCandidateEffect[],
): AccountState | HtlcPaymentResult => {
  const account = newState.accounts.get(prepared.nextHop);
  if (!account) {
    recordFailedHtlc(newState, prepared, candidateEffects, 'next-hop-account-missing');
    return rejectHtlcPayment(
      newState,
      `❌ HTLC payment failed: No account with ${formatEntityId(prepared.nextHop)}`,
      `No account with next hop ${formatEntityId(prepared.nextHop)}`,
    );
  }
  const delta = account.state.deltas?.get(prepared.tokenId);
  if (!delta) {
    recordFailedHtlc(newState, prepared, candidateEffects, 'token-delta-missing');
    return rejectHtlcPayment(
      newState,
      '❌ HTLC payment failed: missing account state',
      `No delta state for next hop ${formatEntityId(prepared.nextHop)} token ${prepared.tokenId}`,
    );
  }
  const senderIsLeft = account.state.leftEntity === newState.entityId;
  const capacity = deriveDelta(delta, senderIsLeft).outCapacity;
  if (prepared.senderLockAmount > capacity) {
    htlcLog.info('rejected', {
      context: 'HTLC_PAYMENT',
      reason: 'insufficient-capacity',
      nextHop: formatEntityId(prepared.nextHop),
      required: prepared.senderLockAmount,
      available: capacity,
    });
    addMessage(newState, '❌ HTLC payment failed: insufficient capacity');
    recordFailedHtlc(newState, prepared, candidateEffects, 'insufficient-capacity');
    return { newState, outputs: [], accountTxs: [] };
  }
  return account.state;
};

const buildOutboundLockTx = (prepared: PreparedHtlcPayment): AccountTx => ({
  type: 'htlc_lock',
  data: {
    lockId: prepared.lockId,
    hashlock: prepared.hashlock,
    timelock: prepared.timelock,
    revealBeforeHeight: prepared.revealBeforeHeight,
    amount: prepared.senderLockAmount,
    tokenId: prepared.tokenId,
    deliveryMode: prepared.deliveryMode,
    envelope: prepared.envelope,
  },
});

const recordOriginatedHtlc = (
  newState: EntityState,
  prepared: PreparedHtlcPayment,
  candidateEffects: EntityCandidateEffect[],
): void => {
  newState.htlcRoutes.set(prepared.hashlock, {
    hashlock: prepared.hashlock,
    tokenId: prepared.tokenId,
    amount: prepared.recipientAmount,
    startedAtMs: prepared.startedAtMs,
    originated: true,
    outboundEntity: prepared.nextHop,
    outboundLockId: prepared.lockId,
    createdTimestamp: newState.timestamp,
  });
  candidateEffects.push({
    kind: 'runtimeEvent',
    eventName: 'HtlcInitiated',
    data: {
      entityId: newState.entityId,
      fromEntity: newState.entityId,
      toEntity: prepared.targetEntityId,
      tokenId: prepared.tokenId,
      amount: prepared.recipientAmount.toString(),
      senderAmount: prepared.senderLockAmount.toString(),
      fee: prepared.totalFee.toString(),
      hashlock: prepared.hashlock,
      lockId: prepared.lockId,
      route: prepared.route,
      ...(prepared.description ? { description: prepared.description } : {}),
      startedAtMs: prepared.startedAtMs,
    },
  });
  newState.lockBook.set(prepared.lockId, {
    lockId: prepared.lockId,
    accountId: prepared.nextHop,
    tokenId: prepared.tokenId,
    amount: prepared.senderLockAmount,
    hashlock: prepared.hashlock,
    timelock: prepared.timelock,
    direction: 'outgoing',
    createdAt: BigInt(newState.timestamp),
  });
};

export async function handleHtlcPayment(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'htlcPayment' }>,
  env: EntityRuntimeContext,
  candidateEffects: EntityCandidateEffect[] = [],
  mutableFrameState = false,
): Promise<HtlcPaymentResult> {
  const prepared = await validatePreparedHtlcPayment(env, entityState, entityTx);
  const trace = (message: string, fields: Record<string, unknown> = {}): void => {
    if (env.quietRuntimeLogs !== true) htlcLog.debug(message, fields);
  };
  trace('start', {
    from: shortId(entityState.entityId),
    target: shortId(prepared.targetEntityId),
    tokenId: prepared.tokenId,
    amount: formatAmount(prepared.recipientAmount),
    route: prepared.route.map(shortId),
  });
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const account = requireOutboundCapacity(newState, prepared, candidateEffects);
  if ('newState' in account) return account;

  recordOriginatedHtlc(newState, prepared, candidateEffects);
  const accountTx = buildOutboundLockTx(prepared);
  const accountTxs = [{ accountId: prepared.nextHop, tx: accountTx }];
  addMessage(
    newState,
    `🔒 HTLC: Recipient ${prepared.recipientAmount}, sender lock ${prepared.senderLockAmount} `
      + `(fee ${prepared.totalFee}) to ${formatEntityId(prepared.targetEntityId)} `
      + `via ${prepared.route.length - 1} hops`,
  );
  trace('mempool.queued', {
    account: shortId(prepared.nextHop),
    lockId: shortHash(prepared.lockId),
    revealBeforeHeight: prepared.revealBeforeHeight,
    amount: formatAmount(prepared.senderLockAmount),
    tokenId: prepared.tokenId,
  });

  return { newState, outputs: [], accountTxs };
}
