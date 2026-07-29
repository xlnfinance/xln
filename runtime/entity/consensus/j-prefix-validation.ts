import {
  FinancialDataCorruptionError,
  validateArray,
  validateMapInstance,
  validateNumber,
  validateObject,
  validateString,
} from '../../protocol/validation-primitives';

const CLAIM_KEYS = [
  'jurisdictionRef',
  'baseHeight',
  'scannedThroughHeight',
  'tipBlockHash',
  'eventHistoryRoot',
  'rangeHash',
  'blocks',
] as const;

const rejectUnexpectedKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new FinancialDataCorruptionError(
        `${context} has unexpected key "${key}"`,
      );
    }
  }
};

const validateClaim = (
  value: unknown,
  context: string,
): Record<string, unknown> => {
  const claim = validateObject(value, context);
  for (const key of [
    'jurisdictionRef',
    'tipBlockHash',
    'eventHistoryRoot',
    'rangeHash',
  ] as const) {
    validateString(claim[key], `${context}.${key}`);
  }
  for (const key of ['baseHeight', 'scannedThroughHeight'] as const) {
    const height = validateNumber(claim[key], `${context}.${key}`);
    if (!Number.isSafeInteger(height) || height < 0) {
      throw new FinancialDataCorruptionError(
        `${context}.${key} must be a non-negative safe integer`,
      );
    }
  }
  validateArray(claim['blocks'], `${context}.blocks`);
  return claim;
};

export const validateJPrefixAttestation = (
  value: unknown,
  context: string,
): void => {
  const attestation = validateClaim(value, context);
  rejectUnexpectedKeys(
    attestation,
    [
      ...CLAIM_KEYS,
      'version',
      'entityId',
      'targetEntityHeight',
      'parentFrameHash',
      'validatorId',
      'headers',
      'signature',
    ],
    context,
  );
  if (attestation['version'] !== 1) {
    throw new FinancialDataCorruptionError(`${context}.version must be 1`);
  }
  for (const field of [
    'entityId',
    'parentFrameHash',
    'validatorId',
    'signature',
  ] as const) {
    validateString(attestation[field], `${context}.${field}`);
  }
  const targetHeight = validateNumber(
    attestation['targetEntityHeight'],
    `${context}.targetEntityHeight`,
  );
  if (!Number.isSafeInteger(targetHeight) || targetHeight <= 0) {
    throw new FinancialDataCorruptionError(
      `${context}.targetEntityHeight must be a positive safe integer`,
    );
  }
  const headers = validateArray<unknown>(
    attestation['headers'],
    `${context}.headers`,
  );
  headers.forEach((value, index) => {
    const item = `${context}.headers[${index}]`;
    const header = validateObject(value, item);
    rejectUnexpectedKeys(header, ['jHeight', 'jBlockHash'], item);
    validateNumber(header['jHeight'], `${item}.jHeight`);
    validateString(header['jBlockHash'], `${item}.jBlockHash`);
  });
};

export const validateJPrefixCertificate = (
  value: unknown,
  context: string,
): void => {
  const certificate = validateObject(value, context);
  rejectUnexpectedKeys(
    certificate,
    [
      'version',
      'entityId',
      'targetEntityHeight',
      'parentFrameHash',
      'jurisdictionRef',
      'baseHeight',
      'selected',
      'attestations',
    ],
    context,
  );
  if (certificate['version'] !== 1) {
    throw new FinancialDataCorruptionError(`${context}.version must be 1`);
  }
  for (const field of ['entityId', 'parentFrameHash', 'jurisdictionRef'] as const) {
    validateString(certificate[field], `${context}.${field}`);
  }
  validateNumber(certificate['targetEntityHeight'], `${context}.targetEntityHeight`);
  validateNumber(certificate['baseHeight'], `${context}.baseHeight`);
  const selected = validateClaim(certificate['selected'], `${context}.selected`);
  rejectUnexpectedKeys(selected, [...CLAIM_KEYS], `${context}.selected`);
  const attestations = validateMapInstance(
    certificate['attestations'],
    `${context}.attestations`,
  );
  if (attestations.size === 0) {
    throw new FinancialDataCorruptionError(
      `${context}.attestations cannot be empty`,
    );
  }
  for (const [signerId, attestation] of attestations) {
    validateString(signerId, `${context}.attestations.signerId`);
    validateJPrefixAttestation(
      attestation,
      `${context}.attestations[${String(signerId)}]`,
    );
  }
};
