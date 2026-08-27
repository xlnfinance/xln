import { validateAccountReplica } from '../../account/validation/state-validation';
import {
  FinancialDataCorruptionError,
  validateMapInstance,
  validateNumber,
  validateObject,
  validateString,
} from '../../protocol/boundary/validation-primitives';
import { PersistentEntityAccountMap } from './persistent-account-map';
import type { ConsensusConfig, EntityState } from '../types';
import { validateEntityAccountMetadata } from '../account/account-metadata-validation';
import { validateEntityCommandState } from '../command/command-state-validation';
import { validateConsensusConfig } from '../consensus/config-validation';
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
    if (typeof amount !== 'bigint' || amount < 0n) {
      throw new FinancialDataCorruptionError(
        `Reserve amount for token ${tokenId} must be a non-negative bigint`,
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
  // Exact decoders still require a real Map at disk/network boundaries. Once
  // hydrated, EntityState owns the canonical persistent Patricia view instead;
  // rejecting that typed view made every crash recovery fail immediately after
  // the no-clone migration. Accept only the two canonical implementations,
  // never a structural/duck-typed map supplied by untrusted input.
  const accounts: ReadonlyMap<string, unknown> = value instanceof Map ||
      value instanceof PersistentEntityAccountMap
    ? value
    : validateMapInstance(value, `${context}.accounts`);
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
