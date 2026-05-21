import { getRuntimeJurisdictionHeight } from '../../j-height';
import { generateLockId, hashHtlcSecret } from '../../htlc-utils';
import type { EntityInput, EntityState, EntityTx, Env } from '../../types';
import { formatEntityId } from '../../utils';
import { cloneEntityState, addMessage } from '../../state-helpers';
import { findAccountKey } from '../account-key';
import type { MempoolOp } from './account';

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

type HtlcEntityTxResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps: MempoolOp[];
};

const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;

const wakeLocalProposer = (state: EntityState, outputs: EntityInput[]): void => {
  const firstValidator = state.config.validators[0];
  if (firstValidator) outputs.push({ entityId: state.entityId, signerId: firstValidator, entityTxs: [] });
};

export const handleHashlockPaymentEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'hashlockPayment'>,
): HtlcEntityTxResult => {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];
  const { targetEntityId, tokenId, amount, hashlock, description } = entityTx.data;
  const normalizedTarget = findAccountKey(newState, targetEntityId);
  if (!normalizedTarget) {
    addMessage(newState, `❌ Hashlock payment failed: no account with ${formatEntityId(targetEntityId)}`);
    return { newState, outputs, mempoolOps };
  }
  const amountBig = typeof amount === 'bigint' ? amount : BigInt(String(amount));
  if (amountBig <= 0n) {
    addMessage(newState, '❌ Hashlock payment failed: invalid amount');
    return { newState, outputs, mempoolOps };
  }
  if (!HEX_32_RE.test(hashlock)) {
    addMessage(newState, '❌ Hashlock payment failed: invalid hashlock');
    return { newState, outputs, mempoolOps };
  }

  const accountMachine = newState.accounts.get(normalizedTarget);
  const preparedLockId = typeof entityTx.data.lockId === 'string' ? entityTx.data.lockId : '';
  const explicitLockId = HEX_32_RE.test(preparedLockId);
  let lockNonce = (accountMachine?.currentHeight ?? 0) + (accountMachine?.mempool?.length ?? 0);
  let lockId = explicitLockId
    ? preparedLockId
    : generateLockId(hashlock, newState.height, lockNonce, newState.timestamp);
  while (
    !explicitLockId &&
    (
      accountMachine?.locks?.has(lockId) ||
      (accountMachine?.mempool ?? []).some((tx) => tx.type === 'htlc_lock' && tx.data.lockId === lockId) ||
      (accountMachine?.pendingFrame?.accountTxs ?? []).some((tx) => tx.type === 'htlc_lock' && tx.data.lockId === lockId)
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
    : getRuntimeJurisdictionHeight(env, newState.lastFinalizedJHeight || 0) + 50;
  if (timelock <= BigInt(newState.timestamp) || !Number.isFinite(revealBeforeHeight) || revealBeforeHeight <= newState.lastFinalizedJHeight) {
    addMessage(newState, '❌ Hashlock payment failed: invalid deadline');
    return { newState, outputs, mempoolOps };
  }

  mempoolOps.push({
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
    if (!(newState.htlcNotes instanceof Map)) newState.htlcNotes = new Map();
    newState.htlcNotes.set(`hashlock:${hashlock}`, description);
    newState.htlcNotes.set(`lock:${lockId}`, description);
  }
  addMessage(newState, `🔒 Hashlock payment locked ${amountBig} token ${tokenId} to ${formatEntityId(normalizedTarget)}`);

  wakeLocalProposer(entityState, outputs);
  return { newState, outputs, mempoolOps };
};

export const handleResolveHtlcLockEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'resolveHtlcLock'>,
): HtlcEntityTxResult => {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];
  const { counterpartyEntityId, lockId, secret } = entityTx.data;
  const normalizedCounterparty = findAccountKey(newState, counterpartyEntityId);
  if (!normalizedCounterparty) {
    addMessage(newState, `❌ HTLC resolve failed: no account with ${formatEntityId(counterpartyEntityId)}`);
    return { newState, outputs, mempoolOps };
  }
  if (!HEX_32_RE.test(lockId)) {
    addMessage(newState, '❌ HTLC resolve failed: invalid lock id');
    return { newState, outputs, mempoolOps };
  }
  let expectedHashlock: string | null = null;
  try {
    expectedHashlock = hashHtlcSecret(secret);
  } catch {
    addMessage(newState, '❌ HTLC resolve failed: invalid secret');
    return { newState, outputs, mempoolOps };
  }
  const account = newState.accounts.get(normalizedCounterparty);
  const lock = account?.locks?.get(lockId);
  if (lock && lock.hashlock !== expectedHashlock) {
    addMessage(newState, '❌ HTLC resolve failed: secret/hashlock mismatch');
    return { newState, outputs, mempoolOps };
  }
  mempoolOps.push({
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
  return { newState, outputs, mempoolOps };
};

export const handleProcessHtlcTimeoutsEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'processHtlcTimeouts'>,
): HtlcEntityTxResult => {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];

  for (const { accountId, lockId } of entityTx.data.expiredLocks || []) {
    mempoolOps.push({
      accountId,
      tx: {
        type: 'htlc_resolve',
        data: { lockId, outcome: 'error' as const, reason: 'timeout' },
      },
    });
  }

  return { newState, outputs, mempoolOps };
};

export const handleRollbackTimedOutFramesEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'rollbackTimedOutFrames'>,
): HtlcEntityTxResult => {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];

  for (const { counterpartyId, frameHeight } of entityTx.data.timedOutAccounts) {
    const accountMachine = newState.accounts.get(counterpartyId);
    if (!accountMachine?.pendingFrame) continue;
    if (accountMachine.pendingFrame.height !== frameHeight) continue;

    for (const tx of accountMachine.pendingFrame.accountTxs) {
      if (tx.type === 'htlc_lock') {
        const hashlock = tx.data.hashlock;
        const route = newState.htlcRoutes.get(hashlock);
        if (route && route.inboundEntity && route.inboundLockId) {
          mempoolOps.push({
            accountId: route.inboundEntity,
            tx: {
              type: 'htlc_resolve',
              data: {
                lockId: route.inboundLockId,
                outcome: 'error' as const,
                reason: 'ack_timeout',
              },
            },
          });
          newState.htlcRoutes.delete(hashlock);
        }
      } else {
        accountMachine.mempool.push(tx);
      }
    }

    delete accountMachine.pendingFrame;
    delete accountMachine.pendingAccountInput;
    delete accountMachine.clonedForValidation;
  }

  return { newState, outputs, mempoolOps };
};

export const handleManualHtlcLockEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'manualHtlcLock'>,
): HtlcEntityTxResult => {
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];

  const { counterpartyId, lockId, hashlock } = entityTx.data;
  const timelock = BigInt(entityTx.data.timelock);
  const revealBeforeHeight = Number(entityTx.data.revealBeforeHeight);
  const amount = BigInt(entityTx.data.amount);
  const tokenId = Number(entityTx.data.tokenId);

  mempoolOps.push({
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

  return { newState, outputs, mempoolOps };
};
