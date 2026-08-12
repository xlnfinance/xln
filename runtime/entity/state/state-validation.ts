import { validateAccountReplica } from '../../account/validation/state-validation';
import { LIMITS } from '../../config/constants';
import {
  FinancialDataCorruptionError,
  validateMapInstance,
  validateNumber,
  validateObject,
  validateString,
} from '../../protocol/boundary/validation-primitives';
import type { ConsensusConfig, EntityState } from '../types';
import { assertEntityAccountCountWithinLimit } from '../account/account-capacity';
import { validateEntityAccountMetadata } from '../account/account-metadata-validation';
import { validateEntityCommandState } from '../command/command-state-validation';
import { validateConsensusConfig } from '../consensus/config-validation';
import { assertConsumptionAccumulatorState } from '../consumption/consumption-accumulator';
import { validateExternalWalletState } from '../auth/external-wallet-validation';
import { validateEntityProposals } from './proposal-validation';
import { validateCrontabState } from '../scheduler/validation';


const validateLeaderState = (
  value: unknown,
  config: ConsensusConfig,
  context: string,
): void => {
  if (value === undefined) return;
  const leader = validateObject(value, `${context}.leaderState`);
  const activeValidatorId = validateString(
    leader['activeValidatorId'],
    `${context}.leaderState.activeValidatorId`,
  ).toLowerCase();
  const view = validateNumber(leader['view'], `${context}.leaderState.view`);
  const changedAtHeight = validateNumber(
    leader['changedAtHeight'],
    `${context}.leaderState.changedAtHeight`,
  );
  if (
    !Number.isSafeInteger(view) ||
    view < 0 ||
    !Number.isSafeInteger(changedAtHeight) ||
    changedAtHeight < 0
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.leaderState counters must be non-negative safe integers`,
    );
  }
  if (
    !config.validators.some(
      (validator) => validator.toLowerCase() === activeValidatorId,
    )
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.leaderState.activeValidatorId must be a board validator`,
    );
  }
};

const validateConsumption = (
  value: unknown,
  context: string,
): void => {
  if (value === undefined) return;
  try {
    assertConsumptionAccumulatorState(
      value as NonNullable<EntityState['consumptionAccumulator']>,
    );
  } catch (error) {
    throw new FinancialDataCorruptionError(
      `${context}.consumptionAccumulator invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const validateCertifiedOutputSequences = (
  value: unknown,
  context: string,
): void => {
  if (value === undefined) return;
  const sequences = validateMapInstance(
    value,
    `${context}.certifiedOutputSequences`,
  );
  if (sequences.size > LIMITS.MAX_ACCOUNTS_PER_ENTITY) {
    throw new FinancialDataCorruptionError(
      `${context}.certifiedOutputSequences exceeds ${LIMITS.MAX_ACCOUNTS_PER_ENTITY}`,
    );
  }
  for (const [rawTarget, rawFrontier] of sequences) {
    const target = String(rawTarget ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(target) || target !== rawTarget) {
      throw new FinancialDataCorruptionError(
        `${context}.certifiedOutputSequences target invalid`,
      );
    }
    const item = `${context}.certifiedOutputSequences.${target}`;
    const frontier = validateObject(rawFrontier, item);
    if (Object.keys(frontier).sort().join(',') !== 'lastSemanticHash,lastSequence') {
      throw new FinancialDataCorruptionError(`${item} fields invalid`);
    }
    if (
      typeof frontier['lastSequence'] !== 'bigint' ||
      frontier['lastSequence'] < 1n
    ) {
      throw new FinancialDataCorruptionError(`${item} sequence invalid`);
    }
    if (!/^0x[0-9a-f]{64}$/.test(String(frontier['lastSemanticHash'] ?? ''))) {
      throw new FinancialDataCorruptionError(`${item} hash invalid`);
    }
  }
};

const validateCertifiedBoardState = (
  value: unknown,
  context: string,
): void => {
  if (value === undefined) return;
  const state = validateObject(value, `${context}.certifiedBoardState`);
  const height = validateNumber(
    state['finalizedJHeight'],
    `${context}.certifiedBoardState.finalizedJHeight`,
  );
  const hashes = [
    state['stackKey'],
    state['boardRegistryRoot'],
    state['finalizedJBlockHash'],
    state['eventHistoryRoot'],
  ];
  if (
    hashes.some((hash) => !/^0x[0-9a-f]{64}$/.test(String(hash ?? ''))) ||
    !Number.isSafeInteger(height) ||
    height < 0
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.certifiedBoardState invalid`,
    );
  }
};

const validateReserves = (value: unknown, context: string): void => {
  const reserves = validateMapInstance(value, `${context}.reserves`);
  for (const [tokenId, amount] of reserves) {
    if (
      typeof tokenId !== 'number' ||
      !Number.isInteger(tokenId) ||
      tokenId <= 0
    ) {
      throw new FinancialDataCorruptionError(
        'Reserve token key must be a positive integer',
        { tokenId },
      );
    }
    if (typeof amount !== 'bigint') {
      throw new FinancialDataCorruptionError(
        `Reserve amount for token ${tokenId} must be bigint`,
        { tokenId, amount },
      );
    }
  }
};

const validateAccounts = (
  value: unknown,
  entityId: string,
  context: string,
): void => {
  const accounts = validateMapInstance(value, `${context}.accounts`);
  assertEntityAccountCountWithinLimit(
    accounts as Map<string, unknown>,
    `${context}.accounts`,
  );
  const canonicalEntityId = entityId.trim().toLowerCase();
  for (const [rawAccountId, value] of accounts) {
    if (
      typeof rawAccountId !== 'string' ||
      rawAccountId !== rawAccountId.trim().toLowerCase()
    ) {
      throw new FinancialDataCorruptionError(
        `${context}.accounts contains non-canonical counterparty key`,
        { accountId: rawAccountId },
      );
    }
    const account = validateAccountReplica(
      value,
      `${context}.accounts[${rawAccountId}]`,
    );
    const leftEntity = account.state.leftEntity.trim().toLowerCase();
    const rightEntity = account.state.rightEntity.trim().toLowerCase();
    const expectedCounterparty = canonicalEntityId === leftEntity
      ? rightEntity
      : canonicalEntityId === rightEntity
        ? leftEntity
        : '';
    if (!expectedCounterparty || rawAccountId !== expectedCounterparty) {
      throw new FinancialDataCorruptionError(
        `${context}.accounts counterparty key does not match Account participants`,
        {
          accountId: rawAccountId,
          entityId: canonicalEntityId,
          leftEntity,
          rightEntity,
        },
      );
    }
  }
};

function assertEntityState(
  entity: Record<string, unknown>,
  context: string,
): asserts entity is Record<string, unknown> & EntityState {
  const entityId = validateString(entity['entityId'], `${context}.entityId`);
  if (entityId !== entityId.trim().toLowerCase()) {
    throw new FinancialDataCorruptionError(
      `${context}.entityId must use canonical lowercase form`,
    );
  }
  validateNumber(entity['height'], `${context}.height`);
  validateNumber(entity['timestamp'], `${context}.timestamp`);
  const config = validateConsensusConfig(entity['config'], `${context}.config`);
  validateEntityCommandState(entity, config, context);
  validateEntityProposals(entity['proposals'], context);
  const entityEncryptionPublicKey = validateString(
    entity['entityEncryptionPublicKey'],
    `${context}.entityEncryptionPublicKey`,
  );
  if (!/^0x[0-9a-f]{64}$/.test(entityEncryptionPublicKey)) {
    throw new FinancialDataCorruptionError(
      `${context}.entityEncryptionPublicKey must be canonical X25519 hex`,
    );
  }
  validateLeaderState(entity['leaderState'], config, context);
  validateReserves(entity['reserves'], context);
  validateAccounts(entity['accounts'], entityId, context);
  validateEntityAccountMetadata(entity, context);
  validateConsumption(entity['consumptionAccumulator'], context);
  validateCertifiedOutputSequences(entity['certifiedOutputSequences'], context);
  validateCertifiedBoardState(entity['certifiedBoardState'], context);
  validateExternalWalletState(entity['externalWallet'], context);
  if (entity['crontabState'] !== undefined) {
    validateCrontabState(entity['crontabState'], `${context}.crontabState`);
  }
  if (entity['lending'] !== undefined) {
    const lending = validateObject(entity['lending'], `${context}.lending`);
    validateMapInstance(lending['pools'], `${context}.lending.pools`);
    validateMapInstance(lending['loans'], `${context}.lending.loans`);
  }
}

export const validateEntityState = (
  value: unknown,
  context = 'EntityState',
): EntityState => {
  const entity = validateObject(value, context);
  assertEntityState(entity, context);
  return entity;
};
