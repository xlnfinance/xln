import type { TowerProofBody } from './bundle/types';

const requireRecord = (
  value: unknown,
  path: string,
): Record<PropertyKey, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`TOWER_PROOF_BODY_RECORD_REQUIRED:${path}`);
  }
  return value as Record<PropertyKey, unknown>;
};

const requireString = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`TOWER_PROOF_BODY_STRING_REQUIRED:${path}`);
  }
  return value;
};

const requireBigInt = (value: unknown, path: string): bigint => {
  if (typeof value !== 'bigint') {
    throw new Error(`TOWER_PROOF_BODY_BIGINT_REQUIRED:${path}`);
  }
  return value;
};

const requireResponseSeconds = (value: unknown, path: string): bigint => {
  const seconds = requireBigInt(value, path);
  if (seconds < 0n || seconds > 0xffff_ffffn) {
    throw new Error(`TOWER_PROOF_BODY_RESPONSE_SECONDS_INVALID:${path}`);
  }
  return seconds;
};

const requireArray = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(`TOWER_PROOF_BODY_ARRAY_REQUIRED:${path}`);
  }
  return value;
};

/**
 * Decode persisted dispute evidence before giving it to a watchtower.
 *
 * Account evidence is persisted as unknown because storage can contain bytes
 * written by older or corrupt processes. A watchtower must never sign or
 * publish an object merely because it resembles a Solidity ProofBody.
 */
export const decodeTowerProofBody = (value: unknown): TowerProofBody => {
  const body = requireRecord(value, 'root');
  const leftResponseSeconds = requireResponseSeconds(
    body['leftResponseSeconds'],
    'leftResponseSeconds',
  );
  const rightResponseSeconds = requireResponseSeconds(
    body['rightResponseSeconds'],
    'rightResponseSeconds',
  );
  if (leftResponseSeconds + rightResponseSeconds > 365n * 24n * 60n * 60n) {
    throw new Error('TOWER_PROOF_BODY_RESPONSE_TOTAL_INVALID');
  }
  return {
    watchSeed: requireString(body['watchSeed'], 'watchSeed'),
    leftResponseSeconds,
    rightResponseSeconds,
    offdeltas: requireArray(body['offdeltas'], 'offdeltas').map((item, index) =>
      requireBigInt(item, `offdeltas.${index}`),
    ),
    tokenIds: requireArray(body['tokenIds'], 'tokenIds').map((item, index) =>
      requireBigInt(item, `tokenIds.${index}`),
    ),
    transformers: requireArray(body['transformers'], 'transformers').map(
      (rawTransformer, transformerIndex) => {
        const transformer = requireRecord(
          rawTransformer,
          `transformers.${transformerIndex}`,
        );
        return {
          transformerAddress: requireString(
            transformer['transformerAddress'],
            `transformers.${transformerIndex}.transformerAddress`,
          ),
          encodedBatch: requireString(
            transformer['encodedBatch'],
            `transformers.${transformerIndex}.encodedBatch`,
          ),
          allowances: requireArray(
            transformer['allowances'],
            `transformers.${transformerIndex}.allowances`,
          ).map((rawAllowance, allowanceIndex) => {
            const allowance = requireRecord(
              rawAllowance,
              `transformers.${transformerIndex}.allowances.${allowanceIndex}`,
            );
            return {
              deltaIndex: requireBigInt(
                allowance['deltaIndex'],
                `transformers.${transformerIndex}.allowances.${allowanceIndex}.deltaIndex`,
              ),
              rightAllowance: requireBigInt(
                allowance['rightAllowance'],
                `transformers.${transformerIndex}.allowances.${allowanceIndex}.rightAllowance`,
              ),
              leftAllowance: requireBigInt(
                allowance['leftAllowance'],
                `transformers.${transformerIndex}.allowances.${allowanceIndex}.leftAllowance`,
              ),
            };
          }),
        };
      },
    ),
  };
};
