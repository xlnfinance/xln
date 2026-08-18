import {
  FinancialDataCorruptionError,
  validateArray,
  validateObject,
} from '../../protocol/boundary/validation-primitives';
import type { ConsensusConfig } from '../types';

const validateShares = (
  value: unknown,
  context: string,
): Record<string, bigint> => {
  const shares = validateObject(value, context);
  for (const [signer, power] of Object.entries(shares)) {
    if (typeof power !== 'bigint') {
      throw new FinancialDataCorruptionError(`${context}.${signer} must be bigint`);
    }
  }
  return shares as Record<string, bigint>;
};

const validateValidators = (
  value: unknown,
  context: string,
): { validators: string[]; normalized: Set<string> } => {
  const values = validateArray<unknown>(value, context);
  if (values.length === 0) {
    throw new FinancialDataCorruptionError(`${context} cannot be empty`);
  }
  const normalized = new Set<string>();
  const validators: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const validator = values[index];
    if (typeof validator !== 'string' || validator.trim().length === 0) {
      throw new FinancialDataCorruptionError(
        `${context}[${index}] must be a non-empty string`,
      );
    }
    const signer = validator.trim().toLowerCase();
    if (normalized.has(signer)) {
      throw new FinancialDataCorruptionError(`${context} has duplicate signer`, {
        validator,
      });
    }
    normalized.add(signer);
    validators.push(validator);
  }
  return { validators, normalized };
};

const validateVotingPower = (
  validators: readonly string[],
  normalizedValidators: ReadonlySet<string>,
  shares: Readonly<Record<string, bigint>>,
  threshold: bigint,
  context: string,
): void => {
  const normalizedShares = new Map<string, bigint>();
  for (const [rawSigner, power] of Object.entries(shares)) {
    const signer = rawSigner.trim().toLowerCase();
    if (normalizedShares.has(signer)) {
      throw new FinancialDataCorruptionError(
        `${context}.shares has case-duplicate signer`,
        { rawSigner },
      );
    }
    normalizedShares.set(signer, power);
  }
  let totalPower = 0n;
  for (const validator of validators) {
    const power = normalizedShares.get(validator.trim().toLowerCase());
    if (typeof power !== 'bigint' || power <= 0n) {
      throw new FinancialDataCorruptionError(
        `${context}.shares missing positive power for validator`,
        { validator },
      );
    }
    if (power > 0xffffn) {
      throw new FinancialDataCorruptionError(
        `${context}.shares exceeds uint16 board encoding`,
        { validator, power },
      );
    }
    totalPower += power;
  }
  for (const signer of Object.keys(shares)) {
    if (!normalizedValidators.has(signer.trim().toLowerCase())) {
      throw new FinancialDataCorruptionError(
        `${context}.shares contains signer outside validators`,
        { shareSigner: signer },
      );
    }
  }
  if (totalPower < threshold) {
    throw new FinancialDataCorruptionError(
      `${context}.threshold exceeds total validator power`,
      { threshold, totalPower },
    );
  }
};

function assertConsensusConfig(
  config: Record<string, unknown>,
  context: string,
): asserts config is Record<string, unknown> & ConsensusConfig {
  if (config['mode'] !== 'proposer-based' && config['mode'] !== 'gossip-based') {
    throw new FinancialDataCorruptionError(
      `${context}.mode must be proposer-based or gossip-based`,
    );
  }
  const threshold = config['threshold'];
  if (typeof threshold !== 'bigint' || threshold <= 0n) {
    throw new FinancialDataCorruptionError(
      `${context}.threshold must be positive bigint`,
    );
  }
  if (threshold > 0xffffn) {
    throw new FinancialDataCorruptionError(
      `${context}.threshold exceeds uint16 board encoding`,
      { threshold },
    );
  }
  const { validators, normalized } = validateValidators(
    config['validators'],
    `${context}.validators`,
  );
  const shares = validateShares(config['shares'], `${context}.shares`);
  validateVotingPower(validators, normalized, shares, threshold, context);
}

export const validateConsensusConfig = (
  value: unknown,
  context = 'ConsensusConfig',
): ConsensusConfig => {
  const config = validateObject(value, context);
  assertConsensusConfig(config, context);
  return config;
};
