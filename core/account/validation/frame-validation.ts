import type { AccountFrame } from '../../types/account';
import {
  FinancialDataCorruptionError,
  validateArray,
  validateObject,
  validateString,
} from '../../protocol/boundary/validation-primitives';
import { assertAccountFrameDeltaIntegrity } from '../state/frame';
import { assertAccountDeltaCapacity } from '../state/delta';
import { validateDelta } from './delta-validation';
import { decodeAccountTxs } from '../tx-validation';
import {
  requireBoundaryInteger,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import { toFrameHash, toStateHash, type FrameHash, type StateHash } from '../../protocol/hashes';
import {
  toAccountHeight,
  toJHeight,
  toUnixMs,
  type AccountHeight,
  type JHeight,
  type UnixMs,
} from '../../protocol/units';

const isBytes32 = (value: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(value);

function decodeFrameHash(
  value: unknown,
  field: 'stateHash',
  height: number,
  context: string,
): FrameHash | '';
function decodeFrameHash(
  value: unknown,
  field: 'prevFrameHash',
  height: number,
  context: string,
): FrameHash | 'genesis' | '';
function decodeFrameHash(
  value: unknown,
  field: 'prevFrameHash' | 'stateHash',
  height: number,
  context: string,
): FrameHash | 'genesis' | '' {
  if (typeof value !== 'string') {
    throw new FinancialDataCorruptionError(`${context}.${field} must be a string`);
  }
  const hash = value;
  const valid = field === 'stateHash'
    ? (height === 0 ? hash === '' : isBytes32(hash))
    : (
        height === 0
          ? hash === ''
          : height === 1
            ? hash === 'genesis'
            : isBytes32(hash)
      );
  if (!valid) {
    throw new FinancialDataCorruptionError(
      `${context}.${field} is invalid for height ${height}:value=${hash}`,
    );
  }
  return hash === '' || hash === 'genesis' ? hash : toFrameHash(hash);
}

export type DecodedAccountFrame = AccountFrame & Readonly<{
  height: AccountHeight;
  timestamp: UnixMs;
  jHeight: JHeight;
  accountStateRoot: StateHash;
  stateHash: FrameHash | '';
  prevFrameHash: FrameHash | 'genesis' | '';
}>;

/**
 * Decode unknown storage/wire data into the only valid AccountFrame shape.
 * Callers inside Account consensus receive an already checked frame.
 */
export const decodeAccountFrame = (
  value: unknown,
  context = 'AccountFrame',
): DecodedAccountFrame => {
  const frame = validateObject(value, context);
  requireExactBoundaryKeys(
    frame,
    [
      'height', 'timestamp', 'jHeight', 'accountTxs', 'prevFrameHash',
      'accountStateRoot', 'stateHash', 'deltas', 'byLeft',
    ],
    [],
    `${context}.fields`,
  );
  const height = toAccountHeight(requireBoundaryInteger(frame['height'], `${context}.height`));
  const accountStateRoot = validateString(
    frame['accountStateRoot'],
    `${context}.accountStateRoot`,
  );
  if (!/^0x[0-9a-fA-F]{64}$/.test(accountStateRoot)) {
    throw new FinancialDataCorruptionError(
      `${context}.accountStateRoot must be bytes32 hex`,
    );
  }
  const byLeft = frame['byLeft'];
  if (typeof byLeft !== 'boolean') {
    throw new FinancialDataCorruptionError(`${context}.byLeft must be boolean`);
  }

  const deltas = validateArray(frame['deltas'], `${context}.deltas`);
  assertAccountDeltaCapacity(deltas.length, `${context}.deltas`);
  const decoded: DecodedAccountFrame = {
    height,
    timestamp: toUnixMs(requireBoundaryInteger(frame['timestamp'], `${context}.timestamp`)),
    jHeight: toJHeight(requireBoundaryInteger(frame['jHeight'], `${context}.jHeight`)),
    accountTxs: decodeAccountTxs(frame['accountTxs'], `${context}.accountTxs`),
    prevFrameHash: decodeFrameHash(
      frame['prevFrameHash'],
      'prevFrameHash',
      height,
      context,
    ),
    accountStateRoot: toStateHash(accountStateRoot),
    stateHash: decodeFrameHash(
      frame['stateHash'],
      'stateHash',
      height,
      context,
    ),
    deltas: deltas.map(
      (delta, index) => validateDelta(delta, `${context}.deltas[${index}]`),
    ),
    byLeft,
  };
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
