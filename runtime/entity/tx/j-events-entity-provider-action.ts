import type { EntityState } from '../../types';
import type {
  EntityProviderActionCancelledData,
  EntityProviderActionExecutedData,
  EntityProviderActionIntent,
  EntityProviderActionState,
} from '../../types/entity-provider-actions';
import { addMessage } from '../../state-helpers';
import { entityProviderActionKindCode } from '../entity-provider-action';

const MAX_UINT256 = (1n << 256n) - 1n;

const bytes32 = (value: unknown, code: string): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${code}:${normalized || 'missing'}`);
  return normalized;
};

const currentActionState = (state: EntityState): EntityProviderActionState => {
  const current = state.entityProviderActionState ?? {
    version: 1 as const,
    confirmedNonce: 0n,
    generation: 0,
  };
  if (
    current.version !== 1 ||
    current.confirmedNonce < 0n ||
    current.confirmedNonce >= MAX_UINT256 ||
    !Number.isSafeInteger(current.generation) ||
    current.generation < 0
  ) throw new Error('ENTITY_PROVIDER_ACTION_STATE_CORRUPT');
  return current;
};

const parseActionNonce = (value: string | bigint): bigint => {
  const nonce = typeof value === 'bigint' ? value : BigInt(String(value));
  if (nonce < 1n || nonce > MAX_UINT256) {
    throw new Error(`ENTITY_PROVIDER_ACTION_EVENT_NONCE_INVALID:${nonce.toString()}`);
  }
  return nonce;
};

const executableIdentity = (
  pending: EntityProviderActionIntent,
): { actionHash: string; actionKind: 0 | 1 } => {
  if (pending.payload.kind === 'cancelPendingAction') {
    return {
      actionHash: pending.payload.cancel.cancelledActionHash.toLowerCase(),
      actionKind: pending.payload.cancel.cancelledActionKind,
    };
  }
  return {
    actionHash: pending.actionHash.toLowerCase(),
    actionKind: entityProviderActionKindCode(pending.payload.kind),
  };
};

export const applyEntityProviderActionExecuted = (
  state: EntityState,
  data: EntityProviderActionExecutedData,
  blockNumber: number,
): void => {
  const eventEntityId = bytes32(data.entityId, 'ENTITY_PROVIDER_ACTION_EVENT_ENTITY_INVALID');
  if (eventEntityId !== state.entityId.toLowerCase()) {
    throw new Error(`ENTITY_PROVIDER_ACTION_EVENT_ENTITY_MISMATCH:${eventEntityId}:${state.entityId}`);
  }
  if (data.actionKind !== 0 && data.actionKind !== 1) {
    throw new Error(`ENTITY_PROVIDER_ACTION_EVENT_KIND_INVALID:${String(data.actionKind)}`);
  }
  const actionHash = bytes32(data.actionHash, 'ENTITY_PROVIDER_ACTION_EVENT_HASH_INVALID');
  const actionNonce = parseActionNonce(data.actionNonce);
  const current = currentActionState(state);
  const expectedNonce = current.confirmedNonce + 1n;
  if (actionNonce !== expectedNonce) {
    throw new Error(
      `ENTITY_PROVIDER_ACTION_EVENT_NONCE_MISMATCH:${actionNonce.toString()}:${expectedNonce.toString()}`,
    );
  }
  const pending = current.pending;
  if (pending) {
    const expected = executableIdentity(pending);
    if (
      pending.actionNonce !== actionNonce ||
      expected.actionHash !== actionHash ||
      expected.actionKind !== data.actionKind
    ) {
      throw new Error(
        `ENTITY_PROVIDER_ACTION_RECEIPT_MISMATCH:` +
        `expected=${pending.actionNonce.toString()}:${expected.actionHash}:${expected.actionKind}:` +
        `received=${actionNonce.toString()}:${actionHash}:${data.actionKind}`,
      );
    }
  }
  state.entityProviderActionState = {
    version: 1,
    confirmedNonce: actionNonce,
    generation: current.generation,
  };
  addMessage(
    state,
    `✅ EntityProvider action finalized (nonce ${actionNonce.toString()}) | Block ${blockNumber}`,
  );
};

export const applyEntityProviderActionCancelled = (
  state: EntityState,
  data: EntityProviderActionCancelledData,
  blockNumber: number,
): void => {
  const eventEntityId = bytes32(data.entityId, 'ENTITY_PROVIDER_CANCEL_EVENT_ENTITY_INVALID');
  if (eventEntityId !== state.entityId.toLowerCase()) {
    throw new Error(`ENTITY_PROVIDER_CANCEL_EVENT_ENTITY_MISMATCH:${eventEntityId}:${state.entityId}`);
  }
  if (data.cancelledActionKind !== 0 && data.cancelledActionKind !== 1) {
    throw new Error(`ENTITY_PROVIDER_CANCEL_EVENT_KIND_INVALID:${String(data.cancelledActionKind)}`);
  }
  const actionNonce = parseActionNonce(data.actionNonce);
  const cancelledActionHash = bytes32(
    data.cancelledActionHash,
    'ENTITY_PROVIDER_CANCEL_EVENT_ACTION_HASH_INVALID',
  );
  const cancelHash = bytes32(data.cancelHash, 'ENTITY_PROVIDER_CANCEL_EVENT_HASH_INVALID');
  const current = currentActionState(state);
  const expectedNonce = current.confirmedNonce + 1n;
  if (actionNonce !== expectedNonce) {
    throw new Error(
      `ENTITY_PROVIDER_CANCEL_EVENT_NONCE_MISMATCH:${actionNonce.toString()}:${expectedNonce.toString()}`,
    );
  }
  const pending = current.pending;
  if (pending) {
    const executable = executableIdentity(pending);
    const cancelIntentMatches = pending.payload.kind !== 'cancelPendingAction' ||
      pending.actionHash.toLowerCase() === cancelHash;
    if (
      pending.actionNonce !== actionNonce ||
      executable.actionHash !== cancelledActionHash ||
      executable.actionKind !== data.cancelledActionKind ||
      !cancelIntentMatches
    ) {
      throw new Error(
        `ENTITY_PROVIDER_CANCEL_RECEIPT_MISMATCH:` +
        `expected=${pending.actionNonce.toString()}:${executable.actionHash}:${executable.actionKind}:` +
        `${pending.payload.kind === 'cancelPendingAction' ? pending.actionHash : 'external-cancel'}:` +
        `received=${actionNonce.toString()}:${cancelledActionHash}:${data.cancelledActionKind}:${cancelHash}`,
      );
    }
  }
  state.entityProviderActionState = {
    version: 1,
    confirmedNonce: actionNonce,
    generation: current.generation,
  };
  addMessage(
    state,
    `🛑 EntityProvider action cancelled (nonce ${actionNonce.toString()}) | Block ${blockNumber}`,
  );
};
