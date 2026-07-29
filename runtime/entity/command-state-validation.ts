import { LIMITS } from '../constants';
import {
  FinancialDataCorruptionError,
  validateMapInstance,
  validateObject,
} from '../protocol/validation-primitives';
import type { ConsensusConfig } from '../types';
import { assertEntityProviderActionIntent } from './entity-provider-action';

const MAX_UINT256 = (1n << 256n) - 1n;

const validateCommandNonces = (value: unknown, context: string): void => {
  if (value === undefined) return;
  const state = validateObject(value, `${context}.entityCommandNonces`);
  if (
    state['version'] !== 1 ||
    !/^0x[0-9a-f]{64}$/.test(String(state['boardHash'] ?? '')) ||
    !Number.isSafeInteger(state['boardEpoch']) ||
    Number(state['boardEpoch']) < 0
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.entityCommandNonces header invalid`,
    );
  }
  const bySigner = validateMapInstance(
    state['bySigner'],
    `${context}.entityCommandNonces.bySigner`,
  );
  if (bySigner.size > LIMITS.MAX_VALIDATORS) {
    throw new FinancialDataCorruptionError(
      `${context}.entityCommandNonces exceeds bounded signer slots`,
    );
  }
  for (const [rawSignerId, rawRecord] of bySigner) {
    const signerId =
      typeof rawSignerId === 'string' ? rawSignerId.trim().toLowerCase() : '';
    const record =
      rawRecord && typeof rawRecord === 'object'
        ? (rawRecord as { nonce?: unknown; commandHash?: unknown })
        : null;
    if (
      !signerId ||
      Object.keys(record ?? {}).sort().join(',') !== 'commandHash,nonce' ||
      typeof record?.nonce !== 'bigint' ||
      record.nonce < 1n ||
      !/^0x[0-9a-f]{64}$/.test(String(record.commandHash ?? ''))
    ) {
      throw new FinancialDataCorruptionError(
        `${context}.entityCommandNonces contains invalid signer, nonce, or command hash`,
      );
    }
  }
};

export const validateEntityCommandState = (
  entity: Record<string, unknown>,
  config: ConsensusConfig,
  context: string,
): void => {
  validateCommandNonces(entity['entityCommandNonces'], context);
  if (entity['entityProviderActionState'] === undefined) return;
  const state = validateObject(
    entity['entityProviderActionState'],
    `${context}.entityProviderActionState`,
  );
  if (
    state['version'] !== 1 ||
    typeof state['confirmedNonce'] !== 'bigint' ||
    state['confirmedNonce'] < 0n ||
    state['confirmedNonce'] > MAX_UINT256 ||
    !Number.isSafeInteger(state['generation']) ||
    Number(state['generation']) < 0
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.entityProviderActionState header invalid`,
    );
  }
  if (state['pending'] === undefined) return;
  const pending = validateObject(
    state['pending'],
    `${context}.entityProviderActionState.pending`,
  );
  validateObject(
    pending['payload'],
    `${context}.entityProviderActionState.pending.payload`,
  );
  if (
    typeof pending['actionNonce'] !== 'bigint' ||
    pending['actionNonce'] !== state['confirmedNonce'] + 1n ||
    pending['generation'] !== state['generation']
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.entityProviderActionState.pending invalid`,
    );
  }
  const jurisdiction = config.jurisdiction;
  if (!jurisdiction?.chainId) {
    throw new FinancialDataCorruptionError(
      `${context}.entityProviderActionState jurisdiction missing`,
    );
  }
  try {
    assertEntityProviderActionIntent(pending, {
        chainId: jurisdiction.chainId,
        entityProviderAddress: jurisdiction.entityProviderAddress,
        depositoryAddress: jurisdiction.depositoryAddress,
        entityId: String(entity['entityId']),
    });
  } catch (error) {
    throw new FinancialDataCorruptionError(
      `${context}.entityProviderActionState.pending cryptographic binding invalid`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
};
