import type { AccountFrame } from '../types/account';
import {
  FinancialDataCorruptionError,
  validateArray,
  validateNumber,
  validateObject,
  validateString,
} from '../protocol/validation-primitives';
import { assertAccountFrameDeltaIntegrity } from './frame';
import { validateDelta } from './delta-validation';

/**
 * Decode unknown storage/wire data into the only valid AccountFrame shape.
 * Callers inside Account consensus receive an already checked frame.
 */
export const decodeAccountFrame = (
  value: unknown,
  context = 'AccountFrame',
): AccountFrame => {
  const frame = validateObject(value, context);
  const height = validateNumber(frame['height'], `${context}.height`);
  const optionalAtGenesis = (field: 'prevFrameHash' | 'stateHash'): string => {
    const raw = frame[field];
    return typeof raw === 'string' && (raw.length > 0 || height === 0)
      ? raw
      : validateString(raw, `${context}.${field}`);
  };
  const accountStateRoot = validateString(
    frame['accountStateRoot'],
    `${context}.accountStateRoot`,
  );
  if (!/^0x[0-9a-fA-F]{64}$/.test(accountStateRoot)) {
    throw new FinancialDataCorruptionError(
      `${context}.accountStateRoot must be bytes32 hex`,
    );
  }

  const decoded: AccountFrame = {
    height,
    timestamp: validateNumber(frame['timestamp'], `${context}.timestamp`),
    jHeight: validateNumber(frame['jHeight'], `${context}.jHeight`),
    accountTxs: validateArray(frame['accountTxs'], `${context}.accountTxs`),
    prevFrameHash: optionalAtGenesis('prevFrameHash'),
    accountStateRoot,
    stateHash: optionalAtGenesis('stateHash'),
    deltas: validateArray(frame['deltas'] || [], `${context}.deltas`).map(
      (delta, index) => validateDelta(delta, `${context}.deltas[${index}]`),
    ),
    ...(typeof frame['byLeft'] === 'boolean'
      ? { byLeft: frame['byLeft'] }
      : {}),
  };
  if (decoded.height > 0 && decoded.stateHash.length === 0) {
    throw new FinancialDataCorruptionError(
      'AccountFrame.stateHash cannot be empty',
    );
  }
  if (decoded.height > 0 && decoded.timestamp <= 0) {
    throw new FinancialDataCorruptionError(
      'AccountFrame.timestamp must be positive',
      { timestamp: decoded.timestamp },
    );
  }
  try {
    assertAccountFrameDeltaIntegrity(decoded, context);
  } catch (error) {
    throw new FinancialDataCorruptionError(
      error instanceof Error ? error.message : String(error),
    );
  }
  return decoded;
};
