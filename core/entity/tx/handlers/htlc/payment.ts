/**
 * Deterministic Entity replay for a proposer-sealed HTLC payment.
 *
 * Route discovery, preimage generation, and onion construction happen once
 * during proposer frame assembly. Validators never receive the preimage; they
 * verify the public route/profile/domain evidence, exact debit/fees, deadlines,
 * and opaque ciphertext shape before signing the exact frame bytes.
 */

import type { AccountTx } from '../../../../types/account';
import type { EntityCandidateEffect, EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import { validatePreparedHtlcPayment } from '../../../htlc/payment-admission';
import { createStructuredLogger, formatAmount, shortHash, shortId } from '../../../../support/logger';
import type { EntityInfraContext } from '../../../../types/entity/infra-context';

const htlcLog = createStructuredLogger('entity.htlc');
const formatEntityId = (id: string): string => id.slice(-4);
type PreparedHtlcPayment = Awaited<ReturnType<typeof validatePreparedHtlcPayment>>;
type HtlcPaymentResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs: Array<{ accountId: string; tx: AccountTx }>;
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
    outboundEntity: prepared.nextHopEntityId,
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
    accountId: prepared.nextHopEntityId,
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
  infraContext?: EntityInfraContext,
): Promise<HtlcPaymentResult> {
  const prepared = validatePreparedHtlcPayment(entityState, entityTx, infraContext);
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
  recordOriginatedHtlc(newState, prepared, candidateEffects);
  const accountTx = buildOutboundLockTx(prepared);
  const accountTxs = [{ accountId: prepared.nextHopEntityId, tx: accountTx }];
  addMessage(
    newState,
    `🔒 HTLC: Recipient ${prepared.recipientAmount}, sender lock ${prepared.senderLockAmount} `
      + `(fee ${prepared.totalFee}) to ${formatEntityId(prepared.targetEntityId)} `
      + `via ${prepared.route.length - 1} hops`,
  );
  trace('mempool.queued', {
    account: shortId(prepared.nextHopEntityId),
    lockId: shortHash(prepared.lockId),
    revealBeforeHeight: prepared.revealBeforeHeight,
    amount: formatAmount(prepared.senderLockAmount),
    tokenId: prepared.tokenId,
  });

  return { newState, outputs: [], accountTxs };
}
