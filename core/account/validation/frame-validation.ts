import type { AccountFrame } from '../../types/account';
import {
  FinancialDataCorruptionError,
  validateObject,
  validateString,
} from '../../protocol/boundary/validation-primitives';
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
  field: 'prevFrameHash',
  height: number,
  context: string,
): FrameHash | 'genesis' | '';
function decodeFrameHash(
  value: unknown,
  field: 'prevFrameHash',
  height: number,
  context: string,
): FrameHash | 'genesis' | '' {
  if (typeof value !== 'string') {
    throw new FinancialDataCorruptionError(`${context}.${field} must be a string`);
  }
  const hash = value;
  const valid = height === 0
    ? hash === ''
    : height === 1
      ? hash === 'genesis'
      : isBytes32(hash);
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
      'accountStateRoot', 'stateHash',
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
  const stateHashValue = frame['stateHash'];
  if (typeof stateHashValue !== 'string') {
    throw new FinancialDataCorruptionError(`${context}.stateHash must be a string`);
  }
  const stateHash = stateHashValue;
  if (height === 0 ? stateHash !== '' : !isBytes32(stateHash)) {
    throw new FinancialDataCorruptionError(
      `${context}.stateHash is invalid for height ${height}:value=${stateHash}`,
    );
  }
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
    stateHash,
  };
  if (decoded.height > 0 && decoded.timestamp <= 0) {
    throw new FinancialDataCorruptionError(
      'AccountFrame.timestamp must be positive',
      { timestamp: decoded.timestamp },
    );
  }
  return decoded;
};
