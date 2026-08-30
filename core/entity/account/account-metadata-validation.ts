import {
  FinancialDataCorruptionError,
  validateMapInstance,
} from '../../protocol/boundary/validation-primitives';
import { PersistentEntityAccountMap } from '../state/persistent-account-map';
import { PersistentEntityCollectionMap } from '../state/persistent-collection-map';

const ENTITY_ID_PATTERN = /^0x[0-9a-f]{64}$/;

export const validateSettlementContinuationValue = (
  value: unknown,
  context: string,
): void => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FinancialDataCorruptionError(`${context} value invalid`);
  }
  const continuation = value as Record<string, unknown>;
  const keys = Object.keys(continuation).sort();
  if (keys.join(',') !== 'actions,broadcast,workspaceHash') {
    throw new FinancialDataCorruptionError(`${context} fields invalid`);
  }
  if (!ENTITY_ID_PATTERN.test(String(continuation['workspaceHash'] ?? ''))) {
    throw new FinancialDataCorruptionError(`${context} workspace hash invalid`);
  }
  const actions = continuation['actions'];
  if (!Array.isArray(actions) || actions.length > 1) {
    throw new FinancialDataCorruptionError(`${context} actions invalid`);
  }
  if (typeof continuation['broadcast'] !== 'boolean') {
    throw new FinancialDataCorruptionError(`${context} broadcast invalid`);
  }
  for (const [index, rawAction] of actions.entries()) {
    if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) {
      throw new FinancialDataCorruptionError(`${context} action ${index} invalid`);
    }
    const action = rawAction as Record<string, unknown>;
    const type = action['type'];
    const expectedKeys = type === 'r2r'
      ? ['amount', 'toEntityId', 'tokenId', 'type']
      : type === 'r2e'
        ? ['amount', 'receivingEntity', 'tokenId', 'type']
        : type === 'r2c'
          ? [
              'amount',
              'counterpartyId',
              ...(action['receivingEntityId'] === undefined ? [] : ['receivingEntityId']),
              'tokenId',
              'type',
            ].sort()
          : [];
    if (expectedKeys.length === 0 || Object.keys(action).sort().join(',') !== expectedKeys.join(',')) {
      throw new FinancialDataCorruptionError(`${context} action ${index} fields invalid`);
    }
    if (!Number.isSafeInteger(action['tokenId']) || Number(action['tokenId']) < 0) {
      throw new FinancialDataCorruptionError(`${context} action ${index} token invalid`);
    }
    if (typeof action['amount'] !== 'bigint' || action['amount'] <= 0n) {
      throw new FinancialDataCorruptionError(`${context} action ${index} amount invalid`);
    }
    const ids = type === 'r2r'
      ? [action['toEntityId']]
      : type === 'r2e'
        ? [action['receivingEntity']]
        : [action['counterpartyId'], ...(action['receivingEntityId'] ? [action['receivingEntityId']] : [])];
    if (ids.some((id) => typeof id !== 'string' || !ENTITY_ID_PATTERN.test(id))) {
      throw new FinancialDataCorruptionError(`${context} action ${index} entity invalid`);
    }
  }
};

export const validateEntityAccountMetadata = (
  entity: Record<string, unknown>,
  context: string,
): void => {
  // Hydrated live state uses the canonical persistent Patricia view. Keep the
  // boundary strict: only that class or an actual decoded Map is accepted.
  const rawAccounts = entity['accounts'];
  const accounts: ReadonlyMap<unknown, unknown> = rawAccounts instanceof PersistentEntityAccountMap
    ? rawAccounts
    : validateMapInstance(rawAccounts, `${context}.accounts`);
  const validateCollectionMap = (
    value: unknown,
    field: string,
  ): ReadonlyMap<unknown, unknown> => value instanceof PersistentEntityCollectionMap
    ? value
    : validateMapInstance(value, `${context}.${field}`);
  const validateAccountKey = (rawAccountId: unknown, field: string): string => {
    const accountId = String(rawAccountId ?? '');
    if (!/^0x[0-9a-f]{64}$/.test(accountId) || accountId !== rawAccountId) {
      throw new FinancialDataCorruptionError(
        `${context}.${field} account invalid`,
      );
    }
    if (!accounts.has(accountId)) {
      throw new FinancialDataCorruptionError(
        `${context}.${field} account missing`,
      );
    }
    return accountId;
  };

  if (entity['deferredAccountProposals'] !== undefined) {
    const deferred = validateCollectionMap(
      entity['deferredAccountProposals'],
      'deferredAccountProposals',
    );
    for (const [rawAccountId, rawWorkspaceHash] of deferred) {
      validateAccountKey(rawAccountId, 'deferredAccountProposals');
      const workspaceHash = String(rawWorkspaceHash ?? '');
      if (
        !/^0x[0-9a-f]{64}$/.test(workspaceHash) ||
        workspaceHash !== rawWorkspaceHash
      ) {
        throw new FinancialDataCorruptionError(
          `${context}.deferredAccountProposals workspace hash invalid`,
        );
      }
    }
  }

  if (entity['settlementContinuations'] === undefined) return;
  const continuations = validateCollectionMap(
    entity['settlementContinuations'],
    'settlementContinuations',
  );
  for (const [rawAccountId, rawContinuation] of continuations) {
    validateAccountKey(rawAccountId, 'settlementContinuations');
    validateSettlementContinuationValue(
      rawContinuation,
      `${context}.settlementContinuations`,
    );
  }
};
