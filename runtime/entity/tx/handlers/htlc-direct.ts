import { getEntityCertifiedJurisdictionHeight } from '../../../jurisdiction/height';
import { generateLockId, hashHtlcSecret } from '../../../protocol/htlc/utils';
import type { EntityInput, EntityState, EntityTx, RuntimeState } from '../../../types';
import { formatEntityId } from '../../../presentation/identity-display';
import { prepareEntityTxState } from '../../state-clone';
import { addMessage } from '../../frame-events';
import { findAccountKey } from '../account-key';
import type { AccountTxTarget } from './account';
import { persistVerifiedHtlcSecret, setHtlcRouteNote } from '../htlc-route-lifecycle';

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

type HtlcEntityTxResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs: AccountTxTarget[];
};

const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;

const wakeLocalProposer = (state: EntityState, outputs: EntityInput[]): void => {
  const firstValidator = state.config.validators[0];
  if (firstValidator) outputs.push({ entityId: state.entityId, signerId: firstValidator, entityTxs: [] });
};

export const handleHashlockPaymentEntityTx = (
  _env: RuntimeState,
  entityState: EntityState,
  entityTx: EntityTxOf<'hashlockPayment'>,
  mutableFrameState = false,
): HtlcEntityTxResult => {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];
  const { targetEntityId, tokenId, amount, hashlock, description } = entityTx.data;
  const normalizedTarget = findAccountKey(newState, targetEntityId);
  if (!normalizedTarget) {
    addMessage(newState, `❌ Hashlock payment failed: no account with ${formatEntityId(targetEntityId)}`);
    return { newState, outputs, accountTxs };
  }
  const amountBig = typeof amount === 'bigint' ? amount : BigInt(String(amount));
  if (amountBig <= 0n) {
    addMessage(newState, '❌ Hashlock payment failed: invalid amount');
    return { newState, outputs, accountTxs };
  }
  if (!HEX_32_RE.test(hashlock)) {
    addMessage(newState, '❌ Hashlock payment failed: invalid hashlock');
    return { newState, outputs, accountTxs };
  }

  const account = newState.accounts.get(normalizedTarget);
  const preparedLockId = typeof entityTx.data.lockId === 'string' ? entityTx.data.lockId : '';
  const explicitLockId = HEX_32_RE.test(preparedLockId);
  let lockNonce = (account?.currentHeight ?? 0) + (account?.mempool?.length ?? 0);
  let lockId = explicitLockId
    ? preparedLockId
    : generateLockId(hashlock, newState.height, lockNonce, newState.timestamp);
  while (
    !explicitLockId &&
    (
      account?.locks?.has(lockId) ||
      (account?.mempool ?? []).some((tx) => tx.type === 'htlc_lock' && tx.data.lockId === lockId) ||
      (account?.pendingFrame?.accountTxs ?? []).some((tx) => tx.type === 'htlc_lock' && tx.data.lockId === lockId)
    )
  ) {
    lockNonce += 1;
    lockId = generateLockId(hashlock, newState.height, lockNonce, newState.timestamp);
  }
  const timelock = entityTx.data.timelock !== undefined
    ? BigInt(entityTx.data.timelock)
    : BigInt(newState.timestamp + 120_000);
  const revealBeforeHeight = entityTx.data.revealBeforeHeight !== undefined
    ? Number(entityTx.data.revealBeforeHeight)
    : getEntityCertifiedJurisdictionHeight(newState) + 50;
  if (timelock <= BigInt(newState.timestamp) || !Number.isFinite(revealBeforeHeight) || revealBeforeHeight <= newState.lastFinalizedJHeight) {
    addMessage(newState, '❌ Hashlock payment failed: invalid deadline');
    return { newState, outputs, accountTxs };
  }

  accountTxs.push({
    accountId: normalizedTarget,
    tx: {
      type: 'htlc_lock',
      data: {
        lockId,
        hashlock,
        timelock,
        revealBeforeHeight,
        amount: amountBig,
        tokenId: Number(tokenId),
      },
    },
  });

  const startedAtMs = typeof entityTx.data.startedAtMs === 'number'
    ? entityTx.data.startedAtMs
    : newState.timestamp;
  newState.htlcRoutes.set(hashlock, {
    hashlock,
    tokenId: Number(tokenId),
    amount: amountBig,
    startedAtMs,
    originated: true,
    outboundEntity: normalizedTarget,
    outboundLockId: lockId,
    ...(entityTx.data.crossJurisdictionRelay ? { crossJurisdictionRelay: entityTx.data.crossJurisdictionRelay } : {}),
    createdTimestamp: newState.timestamp,
  });
  newState.lockBook.set(lockId, {
    lockId,
    accountId: normalizedTarget,
    tokenId: Number(tokenId),
    amount: amountBig,
    hashlock,
    timelock,
    direction: 'outgoing',
    createdAt: BigInt(newState.timestamp),
  });
  if (description && typeof description === 'string') {
    setHtlcRouteNote(newState, hashlock, lockId, description);
  }
  addMessage(newState, `🔒 Hashlock payment locked ${amountBig} token ${tokenId} to ${formatEntityId(normalizedTarget)}`);
  wakeLocalProposer(entityState, outputs);
  return { newState, outputs, accountTxs };
};

export const handleResolveHtlcLockEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'resolveHtlcLock'>,
  mutableFrameState = false,
): HtlcEntityTxResult => {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];
  const { counterpartyEntityId, lockId, secret } = entityTx.data;
  const normalizedCounterparty = findAccountKey(newState, counterpartyEntityId);
  if (!normalizedCounterparty) {
    addMessage(newState, `❌ HTLC resolve failed: no account with ${formatEntityId(counterpartyEntityId)}`);
    return { newState, outputs, accountTxs };
  }
  if (!HEX_32_RE.test(lockId)) {
    addMessage(newState, '❌ HTLC resolve failed: invalid lock id');
    return { newState, outputs, accountTxs };
  }
  let expectedHashlock: string | null = null;
  try {
    expectedHashlock = hashHtlcSecret(secret);
  } catch {
    addMessage(newState, '❌ HTLC resolve failed: invalid secret');
    return { newState, outputs, accountTxs };
  }
  const account = newState.accounts.get(normalizedCounterparty);
  const lock = account?.locks?.get(lockId);
  if (lock && lock.hashlock !== expectedHashlock) {
    addMessage(newState, '❌ HTLC resolve failed: secret/hashlock mismatch');
    return { newState, outputs, accountTxs };
  }
  if (lock) persistVerifiedHtlcSecret(newState, normalizedCounterparty, lock, secret);
  accountTxs.push({
    accountId: normalizedCounterparty,
    tx: {
      type: 'htlc_resolve',
      data: {
        lockId,
        outcome: 'secret',
        secret,
      },
    },
  });
  addMessage(newState, `🔓 HTLC resolve queued for ${formatEntityId(normalizedCounterparty)}`);
  wakeLocalProposer(entityState, outputs);
  return { newState, outputs, accountTxs };
};

export const handleProcessHtlcTimeoutsEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'processHtlcTimeouts'>,
  mutableFrameState = false,
): HtlcEntityTxResult => {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  for (const { accountId, lockId } of entityTx.data.expiredLocks || []) {
    accountTxs.push({
      accountId,
      tx: {
        type: 'htlc_resolve',
        data: { lockId, outcome: 'error' as const, reason: 'timeout' },
      },
    });
  }

  return { newState, outputs, accountTxs };
};

export const handleManualHtlcLockEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'manualHtlcLock'>,
  mutableFrameState = false,
): HtlcEntityTxResult => {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  const { counterpartyId, lockId, hashlock } = entityTx.data;
  const timelock = BigInt(entityTx.data.timelock);
  const revealBeforeHeight = Number(entityTx.data.revealBeforeHeight);
  const amount = BigInt(entityTx.data.amount);
  const tokenId = Number(entityTx.data.tokenId);

  accountTxs.push({
    accountId: counterpartyId,
    tx: {
      type: 'htlc_lock',
      data: {
        lockId,
        hashlock,
        timelock,
        revealBeforeHeight,
        amount,
        tokenId,
      },
    },
  });

  return { newState, outputs, accountTxs };
};
