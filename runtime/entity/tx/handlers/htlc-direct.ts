import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import type { EntityInput, EntityState } from '../../types';
import type { EntityTx } from '../../../types/entity-tx';
import { prepareEntityTxState } from '../../state-clone';
import { addMessage } from '../../frame-events';
import { findAccountKey } from '../account-key';
import type { AccountTxTarget } from './account';
import { persistVerifiedHtlcSecret } from '../htlc-route-lifecycle';

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
    addMessage(newState, `❌ HTLC resolve failed: no account with ${counterpartyEntityId}`);
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
  const lock = account?.state.locks?.get(lockId);
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
  addMessage(newState, `🔓 HTLC resolve queued for ${normalizedCounterparty}`);
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
