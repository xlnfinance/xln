import {
  FinancialDataCorruptionError,
  validateArray,
  validateObject,
  validateString,
} from '../../protocol/validation-primitives';
import { isRuntimeFailureSignal } from '../../protocol/failure-taxonomy';

const MAX_UINT256 = (1n << 256n) - 1n;
const FINGERPRINT_LIMIT = 256;
const OUTCOMES = new Set([
  'submitted',
  'eventBarrier',
  'transientFailure',
  'terminalFailure',
  'reconciled',
]);

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

const validateSafeInteger = (
  value: unknown,
  context: string,
  minimum: number,
): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new FinancialDataCorruptionError(
      `${context} must be a safe integer >= ${minimum}`,
    );
  }
  return Number(value);
};

const validateNonEmptyString = (value: unknown, context: string): string => {
  const validated = validateString(value, context);
  if (!validated.trim()) {
    throw new FinancialDataCorruptionError(`${context} must be non-empty`);
  }
  return validated;
};

const validateAdapterFailure = (value: unknown, context: string): void => {
  const failure = validateObject(value, context);
  rejectUnexpectedKeys(failure, ['category', 'code', 'message'], context);
  if (failure['category'] !== 'transient' && failure['category'] !== 'terminal') {
    throw new FinancialDataCorruptionError(`${context}.category invalid`);
  }
  validateNonEmptyString(failure['code'], `${context}.code`);
  validateNonEmptyString(failure['message'], `${context}.message`);
};

const validateFailure = (
  value: unknown,
  context: string,
  requireRuntimeFailure: boolean,
): void => {
  const failure = validateObject(value, context);
  rejectUnexpectedKeys(
    failure,
    requireRuntimeFailure
      ? ['message', 'failedAt', 'failure', 'adapterFailure']
      : ['message', 'failedAt', 'adapterFailure'],
    context,
  );
  const message = validateNonEmptyString(failure['message'], `${context}.message`);
  validateSafeInteger(failure['failedAt'], `${context}.failedAt`, 0);
  if (requireRuntimeFailure) {
    const signal = failure['failure'];
    if (!isRuntimeFailureSignal(signal)) {
      throw new FinancialDataCorruptionError(
        `${context}.failure must be canonical RuntimeFailureSignal`,
      );
    }
    rejectUnexpectedKeys(
      validateObject(signal, `${context}.failure`),
      ['category', 'code', 'message', 'retryable', 'fatal'],
      `${context}.failure`,
    );
  }
  if (failure['adapterFailure'] === undefined) return;
  validateAdapterFailure(failure['adapterFailure'], `${context}.adapterFailure`);
  const adapter = failure['adapterFailure'] as Record<string, unknown>;
  if (adapter['message'] !== message) {
    throw new FinancialDataCorruptionError(
      `${context}.adapterFailure.message must match message`,
    );
  }
};

const validateResultJournal = (
  state: Record<string, unknown>,
  context: string,
): void => {
  const fingerprintsValue = state['resultFingerprints'];
  const orderValue = state['resultFingerprintOrder'];
  if ((fingerprintsValue === undefined) !== (orderValue === undefined)) {
    throw new FinancialDataCorruptionError(
      `${context} fingerprint map/order must coexist`,
    );
  }
  if (fingerprintsValue !== undefined) {
    const fingerprints = validateObject(
      fingerprintsValue,
      `${context}.resultFingerprints`,
    );
    const order = validateArray<unknown>(
      orderValue,
      `${context}.resultFingerprintOrder`,
    );
    if (
      Object.keys(fingerprints).length > FINGERPRINT_LIMIT ||
      order.length > FINGERPRINT_LIMIT
    ) {
      throw new FinancialDataCorruptionError(
        `${context} exceeds ${FINGERPRINT_LIMIT} result fingerprints`,
      );
    }
    const seen = new Set<string>();
    for (const [attemptId, fingerprint] of Object.entries(fingerprints)) {
      validateNonEmptyString(attemptId, `${context}.resultFingerprints key`);
      validateNonEmptyString(
        fingerprint,
        `${context}.resultFingerprints[${attemptId}]`,
      );
    }
    order.forEach((value, index) => {
      const attemptId = validateNonEmptyString(
        value,
        `${context}.resultFingerprintOrder[${index}]`,
      );
      if (seen.has(attemptId)) {
        throw new FinancialDataCorruptionError(
          `${context}.resultFingerprintOrder contains duplicate ${attemptId}`,
        );
      }
      if (!(attemptId in fingerprints)) {
        throw new FinancialDataCorruptionError(
          `${context}.resultFingerprintOrder contains unknown ${attemptId}`,
        );
      }
      seen.add(attemptId);
    });
    if (seen.size !== Object.keys(fingerprints).length) {
      throw new FinancialDataCorruptionError(
        `${context}.resultFingerprintOrder is incomplete`,
      );
    }
  }
  const hasResult = [
    'lastResultAttemptId',
    'lastResultAt',
    'lastResultOutcome',
    'lastResultFingerprint',
  ].some((field) => state[field] !== undefined);
  if (!hasResult) return;
  const attemptId = validateNonEmptyString(
    state['lastResultAttemptId'],
    `${context}.lastResultAttemptId`,
  );
  validateSafeInteger(state['lastResultAt'], `${context}.lastResultAt`, 0);
  if (!OUTCOMES.has(String(state['lastResultOutcome'] ?? ''))) {
    throw new FinancialDataCorruptionError(`${context}.lastResultOutcome invalid`);
  }
  const fingerprint = validateNonEmptyString(
    state['lastResultFingerprint'],
    `${context}.lastResultFingerprint`,
  );
  const journal = state['resultFingerprints'];
  if (
    journal !== undefined &&
    (journal as Record<string, unknown>)[attemptId] !== fingerprint
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.last result must match fingerprint journal`,
    );
  }
};

const COMMON_FIELDS = [
  'jurisdictionName', 'submitAttempts', 'lastSubmittedAt', 'txHash',
  'lastFailure', 'terminalFailure', 'lastResultAttemptId', 'lastResultAt',
  'lastResultOutcome', 'lastResultFingerprint', 'resultFingerprints',
  'resultFingerprintOrder',
];

export const validateJSubmitState = (
  value: unknown,
  context: string,
): void => {
  const state = validateObject(value, context);
  rejectUnexpectedKeys(
    state,
    ['batchHash', 'entityNonce', 'batchGeneration', ...COMMON_FIELDS],
    context,
  );
  validateNonEmptyString(state['jurisdictionName'], `${context}.jurisdictionName`);
  const hash = validateNonEmptyString(state['batchHash'], `${context}.batchHash`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new FinancialDataCorruptionError(`${context}.batchHash must be bytes32 hex`);
  }
  validateSafeInteger(state['entityNonce'], `${context}.entityNonce`, 0);
  validateSafeInteger(state['batchGeneration'], `${context}.batchGeneration`, 1);
  validateSubmitFields(state, context, true);
};

const validateSubmitFields = (
  state: Record<string, unknown>,
  context: string,
  requireRuntimeFailure: boolean,
): void => {
  validateSafeInteger(state['submitAttempts'], `${context}.submitAttempts`, 1);
  validateSafeInteger(state['lastSubmittedAt'], `${context}.lastSubmittedAt`, 0);
  if (state['txHash'] !== undefined) {
    validateNonEmptyString(state['txHash'], `${context}.txHash`);
  }
  if (state['lastFailure'] !== undefined) {
    validateFailure(state['lastFailure'], `${context}.lastFailure`, requireRuntimeFailure);
  }
  if (state['terminalFailure'] !== undefined) {
    validateFailure(
      state['terminalFailure'],
      `${context}.terminalFailure`,
      requireRuntimeFailure,
    );
  }
  validateResultJournal(state, context);
};

export const validateEntityProviderActionSubmitState = (
  value: unknown,
  context: string,
): void => {
  const state = validateObject(value, context);
  rejectUnexpectedKeys(
    state,
    ['actionHash', 'actionNonce', 'generation', ...COMMON_FIELDS],
    context,
  );
  validateNonEmptyString(state['jurisdictionName'], `${context}.jurisdictionName`);
  const hash = validateNonEmptyString(state['actionHash'], `${context}.actionHash`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new FinancialDataCorruptionError(`${context}.actionHash must be bytes32 hex`);
  }
  if (
    typeof state['actionNonce'] !== 'bigint' ||
    state['actionNonce'] <= 0n ||
    state['actionNonce'] > MAX_UINT256
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.actionNonce must be uint256 > 0`,
    );
  }
  validateSafeInteger(state['generation'], `${context}.generation`, 1);
  validateSubmitFields(state, context, false);
};
