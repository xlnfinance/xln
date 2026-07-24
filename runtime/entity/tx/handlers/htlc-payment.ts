/**
 * Deterministic Entity replay for an ingress-sealed HTLC payment.
 *
 * Route discovery and onion construction happen once at trusted local ingress.
 * The proposer keeps the preimage private. Validators independently verify
 * the public route, certified manifests, exact debit/fees, frozen deadlines,
 * and outer ciphertext bindings; frame hashes commit the opaque bytes exactly.
 */

import type {
  AccountTx,
  EntityCandidateEffect,
  EntityInput,
  EntityState,
  EntityTx,
  Env,
} from '../../../types';
import { addMessage, cloneEntityState } from '../../../state-helpers';
import { deriveDelta } from '../../../account/utils';
import { validatePreparedHtlcPayment } from '../../../protocol/htlc/payment-admission';
import { createStructuredLogger, formatAmount, shortHash, shortId } from '../../../infra/logger';
import { setHtlcRouteNote } from '../htlc-route-lifecycle';

const htlcLog = createStructuredLogger('entity.htlc');
const formatEntityId = (id: string): string => id.slice(-4);

export async function handleHtlcPayment(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'htlcPayment' }>,
  env: Env,
  candidateEffects: EntityCandidateEffect[] = [],
): Promise<{
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps: Array<{ accountId: string; tx: AccountTx }>;
}> {
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
  const newState = cloneEntityState(entityState);
  const account = newState.accounts.get(prepared.nextHop);
  if (!account) {
    htlcLog.error('failed', {
      context: 'HTLC_PAYMENT',
      message: `No account with next hop ${formatEntityId(prepared.nextHop)}`,
    });
    addMessage(newState, `❌ HTLC payment failed: No account with ${formatEntityId(prepared.nextHop)}`);
    return { newState, outputs: [], mempoolOps: [] };
  }
  const delta = account.deltas?.get(prepared.tokenId);
  if (!delta) {
    htlcLog.error('failed', {
      context: 'HTLC_PAYMENT',
      message: `No delta state for next hop ${formatEntityId(prepared.nextHop)} token ${prepared.tokenId}`,
    });
    addMessage(newState, '❌ HTLC payment failed: missing account state');
    return { newState, outputs: [], mempoolOps: [] };
  }
  const senderIsLeft = account.leftEntity === entityState.entityId;
  const nextHopCapacity = deriveDelta(delta, senderIsLeft).outCapacity;
  if (prepared.senderLockAmount > nextHopCapacity) {
    htlcLog.info('rejected', {
      context: 'HTLC_PAYMENT',
      reason: 'insufficient-capacity',
      nextHop: formatEntityId(prepared.nextHop),
      required: prepared.senderLockAmount,
      available: nextHopCapacity,
    });
    addMessage(newState, '❌ HTLC payment failed: insufficient capacity');
    return { newState, outputs: [], mempoolOps: [] };
  }

  newState.htlcRoutes.set(prepared.hashlock, {
    hashlock: prepared.hashlock,
    tokenId: prepared.tokenId,
    amount: prepared.recipientAmount,
    startedAtMs: prepared.startedAtMs,
    outboundEntity: prepared.nextHop,
    outboundLockId: prepared.lockId,
    createdTimestamp: newState.timestamp,
  });
  if (prepared.description) {
    setHtlcRouteNote(newState, prepared.hashlock, prepared.lockId, prepared.description);
  }

  const accountTx: AccountTx = {
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
  };
  const mempoolOps = [{ accountId: prepared.nextHop, tx: accountTx }];
  // Persist the audit event only after this replay has built the exact AccountTx.
  // Emitting before account/capacity validation made rejected payments look sent.
  candidateEffects.push({
    kind: 'runtimeEvent',
    eventName: 'HtlcInitiated',
    data: {
      entityId: entityState.entityId,
      fromEntity: entityState.entityId,
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

  return { newState, outputs: [], mempoolOps };
}
