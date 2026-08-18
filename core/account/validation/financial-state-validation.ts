import { LIMITS, TOKENS } from '../../config/constants.ts';
import { HASHABLE_HTLC_LOCK_FIELDS, HASHABLE_PULL_COMMITMENT_FIELDS } from '../../types/hash-coverage/account-nested';
import { HASHABLE_CROSS_J_PULL_BINDING_FIELDS } from '../../types/hash-coverage/cross-j-nested';
import { requireBoundaryInteger, requireExactBoundaryKeys } from '../../protocol/boundary-validation.ts';
import {
  FinancialDataCorruptionError,
  validateObject,
  validateString,
} from '../../protocol/boundary/validation-primitives.ts';
import { validateAccountStateCollection } from './collection-validation.ts';

const HASH_32 = /^0x[0-9a-f]{64}$/;

const corrupt = (context: string, detail: string): never => {
  throw new FinancialDataCorruptionError(`${context} ${detail}`);
};

const requireHash = (value: unknown, context: string): string => {
  const hash = validateString(value, context);
  if (!HASH_32.test(hash)) corrupt(context, 'must be canonical bytes32');
  return hash;
};

const requireAmount = (value: unknown, context: string, allowZero = false): bigint => {
  if (typeof value !== 'bigint' || value < 0n || (!allowZero && value === 0n)) {
    corrupt(context, allowZero ? 'must be a non-negative bigint' : 'must be a positive bigint');
  }
  return value as bigint;
};

const requireSignedNonZeroAmount = (value: unknown, context: string): bigint => {
  if (typeof value !== 'bigint' || value === 0n) {
    corrupt(context, 'must be a non-zero bigint');
  }
  return value as bigint;
};

const absAmount = (value: bigint): bigint => (value < 0n ? -value : value);

const requireTokenId = (value: unknown, context: string): number => {
  const tokenId = requireBoundaryInteger(value, context, 1);
  if (tokenId > TOKENS.MAX_TOKEN_ID) corrupt(context, 'exceeds canonical token range');
  return tokenId;
};

const validateHtlcLock = (key: unknown, value: unknown, context: string): void => {
  const lock = validateObject(value, context);
  requireExactBoundaryKeys(
    lock,
    HASHABLE_HTLC_LOCK_FIELDS.filter(field => field !== 'envelopeHash'),
    ['envelopeHash'],
    `${context}.fields`,
  );
  const lockId = requireHash(lock['lockId'], `${context}.lockId`);
  if (key !== lockId) corrupt(context, 'Map key must equal lockId');
  requireHash(lock['hashlock'], `${context}.hashlock`);
  requireAmount(lock['timelock'], `${context}.timelock`);
  requireAmount(lock['amount'], `${context}.amount`);
  requireTokenId(lock['tokenId'], `${context}.tokenId`);
  requireBoundaryInteger(lock['revealBeforeHeight'], `${context}.revealBeforeHeight`);
  requireBoundaryInteger(lock['createdHeight'], `${context}.createdHeight`);
  requireBoundaryInteger(lock['createdTimestamp'], `${context}.createdTimestamp`);
  if (typeof lock['senderIsLeft'] !== 'boolean') corrupt(context, 'senderIsLeft must be boolean');
  if (lock['envelopeHash'] !== undefined) requireHash(lock['envelopeHash'], `${context}.envelopeHash`);
};

const PULL_BINDING_REQUIRED = new Set(['orderId', 'routeHash', 'leg']);
const validatePullBinding = (value: unknown, context: string): void => {
  const binding = validateObject(value, context);
  requireExactBoundaryKeys(
    binding,
    ['orderId', 'routeHash', 'leg'],
    HASHABLE_CROSS_J_PULL_BINDING_FIELDS.filter(field => !PULL_BINDING_REQUIRED.has(field)),
    `${context}.fields`,
  );
  validateString(binding['orderId'], `${context}.orderId`);
  requireHash(binding['routeHash'], `${context}.routeHash`);
  if (binding['leg'] !== 'source' && binding['leg'] !== 'target') corrupt(context, 'leg is invalid');
  for (const name of ['cumulativeFillRatio', 'fillSeq', 'claimedRatio']) {
    if (binding[name] !== undefined) requireBoundaryInteger(binding[name], `${context}.${name}`);
  }
  for (const name of ['fillNumerator', 'fillDenominator', 'filledSourceAmount', 'filledTargetAmount', 'sourceClaimed', 'targetClaimed']) {
    if (binding[name] !== undefined) requireAmount(binding[name], `${context}.${name}`, true);
  }
};

const PULL_OPTIONAL = new Set(['claimedRatio', 'claimedAmount']);
const validatePull = (key: unknown, value: unknown, context: string): void => {
  const pull = validateObject(value, context);
  requireExactBoundaryKeys(
    pull,
    HASHABLE_PULL_COMMITMENT_FIELDS.filter(field => !PULL_OPTIONAL.has(field)),
    ['claimedRatio', 'claimedAmount'],
    `${context}.fields`,
  );
  const pullId = validateString(pull['pullId'], `${context}.pullId`);
  if (key !== pullId || pullId.includes(':')) corrupt(context, 'Map key/pullId is invalid');
  requireTokenId(pull['tokenId'], `${context}.tokenId`);
  const amount = requireSignedNonZeroAmount(pull['amount'], `${context}.amount`);
  requireHash(pull['fullHash'], `${context}.fullHash`);
  requireHash(pull['partialRoot'], `${context}.partialRoot`);
  requireBoundaryInteger(pull['createdHeight'], `${context}.createdHeight`);
  requireBoundaryInteger(pull['createdTimestamp'], `${context}.createdTimestamp`);
  if (pull['claimedRatio'] !== undefined) requireBoundaryInteger(pull['claimedRatio'], `${context}.claimedRatio`);
  if (pull['claimedAmount'] !== undefined && requireAmount(pull['claimedAmount'], `${context}.claimedAmount`, true) > absAmount(amount)) {
    corrupt(context, 'claimedAmount exceeds amount');
  }
  validatePullBinding(pull['crossJurisdiction'], `${context}.crossJurisdiction`);
};

const validateWithdrawal = (key: unknown, value: unknown, context: string): void => {
  const withdrawal = validateObject(value, context);
  requireExactBoundaryKeys(withdrawal, [
    'requestId', 'tokenId', 'amount', 'requestedAt', 'direction', 'status',
  ], ['signature'], `${context}.fields`);
  const requestId = validateString(withdrawal['requestId'], `${context}.requestId`);
  if (key !== requestId) corrupt(context, 'Map key must equal requestId');
  requireTokenId(withdrawal['tokenId'], `${context}.tokenId`);
  requireAmount(withdrawal['amount'], `${context}.amount`);
  requireBoundaryInteger(withdrawal['requestedAt'], `${context}.requestedAt`);
  if (withdrawal['direction'] !== 'outgoing' && withdrawal['direction'] !== 'incoming') corrupt(context, 'direction is invalid');
  if (!['pending', 'approved', 'rejected', 'timed_out'].includes(String(withdrawal['status']))) corrupt(context, 'status is invalid');
  if (withdrawal['signature'] !== undefined) validateString(withdrawal['signature'], `${context}.signature`);
};

export const validateAccountFinancialMaps = (
  state: Record<string, unknown>,
  replica: Record<string, unknown>,
  context: string,
): void => {
  const locks = validateAccountStateCollection(state['locks'], `${context}.state.locks`);
  if (locks.size > LIMITS.MAX_ACCOUNT_HTLC_LOCKS) corrupt(context, 'HTLC lock limit exceeded');
  for (const [key, lock] of locks) validateHtlcLock(key, lock, `${context}.state.locks.${String(key)}`);
  if (state['pulls'] !== undefined) {
    const pulls = validateAccountStateCollection(state['pulls'], `${context}.state.pulls`);
    if (pulls.size > LIMITS.MAX_ACCOUNT_SWAP_OFFERS) corrupt(context, 'pull limit exceeded');
    for (const [key, pull] of pulls) validatePull(key, pull, `${context}.state.pulls.${String(key)}`);
  }
  const withdrawals = validateAccountStateCollection(replica['pendingWithdrawals'], `${context}.pendingWithdrawals`);
  for (const [key, withdrawal] of withdrawals) validateWithdrawal(key, withdrawal, `${context}.pendingWithdrawals.${String(key)}`);
};
