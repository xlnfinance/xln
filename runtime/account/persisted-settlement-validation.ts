import { LIMITS } from '../config/constants';
import { compileOps } from '../protocol/settlement/operations';
import { safeStringify } from '../protocol/serialization';
import type { AccountState, SettlementDiff, SettlementOp } from '../types/account';
import { assertCanonicalSettlementWorkspace } from './tx/handlers/settle-transition';
import {
  persistedArray,
  persistedBoolean,
  persistedBytes32,
  persistedEnum,
  persistedHex,
  persistedInt256,
  persistedOptional,
  persistedRecord,
  persistedString,
  persistedTokenId,
  persistedUint,
} from './persisted-value-primitives';

const WORKSPACE_STATUSES = new Set([
  'draft', 'awaiting_counterparty', 'ready_to_submit', 'submitted',
] as const);

const validateSettlementOp = (value: unknown, context: string): SettlementOp => {
  const source = persistedRecord(value, ['type', 'tokenId'], [
    'amount', 'leftDiff', 'rightDiff', 'collateralDiff', 'ondeltaDiff',
  ], context);
  const tokenId = persistedTokenId(source['tokenId'], `${context}.tokenId`);
  const type = source['type'];
  if (type === 'forgive') {
    if (Object.hasOwn(source, 'amount') || Object.hasOwn(source, 'leftDiff')) {
      throw new Error(`${context} forgive contains amount/diff fields`);
    }
    return { type, tokenId };
  }
  if (type === 'r2c' || type === 'c2r' || type === 'r2r') {
    if (typeof source['amount'] !== 'bigint' || source['amount'] <= 0n) {
      throw new Error(`${context}.amount must be a positive bigint`);
    }
    for (const field of ['leftDiff', 'rightDiff', 'collateralDiff', 'ondeltaDiff']) {
      if (Object.hasOwn(source, field)) throw new Error(`${context} transfer op contains raw diff fields`);
    }
    return { type, tokenId, amount: source['amount'] };
  }
  if (type !== 'rawDiff' || Object.hasOwn(source, 'amount')) {
    throw new Error(`${context}.type is invalid`);
  }
  for (const field of ['leftDiff', 'rightDiff', 'collateralDiff', 'ondeltaDiff'] as const) {
    persistedInt256(source[field], `${context}.${field}`);
  }
  return {
    type,
    tokenId,
    leftDiff: source['leftDiff'] as bigint,
    rightDiff: source['rightDiff'] as bigint,
    collateralDiff: source['collateralDiff'] as bigint,
    ondeltaDiff: source['ondeltaDiff'] as bigint,
  };
};

const validateSettlementDiff = (value: unknown, context: string): SettlementDiff => {
  const diff = persistedRecord(value, [
    'tokenId', 'leftDiff', 'rightDiff', 'collateralDiff', 'ondeltaDiff',
  ], [], context);
  const tokenId = persistedTokenId(diff['tokenId'], `${context}.tokenId`);
  for (const field of ['leftDiff', 'rightDiff', 'collateralDiff', 'ondeltaDiff'] as const) {
    persistedInt256(diff[field], `${context}.${field}`);
  }
  return { ...diff, tokenId } as unknown as SettlementDiff;
};

const validatePostSettlementProof = (value: unknown, context: string): void => {
  const proof = persistedRecord(value, [
    'disputeHash', 'proofBodyHash', 'nonce',
  ], ['leftHanko', 'rightHanko'], context);
  persistedBytes32(proof['disputeHash'], `${context}.disputeHash`);
  persistedBytes32(proof['proofBodyHash'], `${context}.proofBodyHash`);
  persistedUint(proof['nonce'], `${context}.nonce`);
  persistedOptional(proof['leftHanko'], item => persistedHex(item, `${context}.leftHanko`));
  persistedOptional(proof['rightHanko'], item => persistedHex(item, `${context}.rightHanko`));
};

export const validatePersistedSettlementWorkspace = (
  state: Pick<AccountState, 'leftEntity' | 'rightEntity'> & Record<string, unknown>,
  context: string,
): void => {
  if (state['settlementWorkspace'] === undefined) return;
  const workspace = persistedRecord(state['settlementWorkspace'], [
    'workspaceHash', 'ops', 'lastModifiedByLeft', 'status', 'revision',
    'createdAt', 'lastUpdatedAt', 'executorIsLeft',
  ], [
    'compiledDiffs', 'compiledForgiveTokenIds', 'leftHanko', 'rightHanko',
    'settlementHash', 'memo', 'nonceAtSign', 'postSettlementDisputeProof',
  ], `${context}.settlementWorkspace`);
  persistedBytes32(workspace['workspaceHash'], `${context}.settlementWorkspace.workspaceHash`);
  const rawOps = persistedArray(
    workspace['ops'],
    `${context}.settlementWorkspace.ops`,
    LIMITS.MAX_ACCOUNT_TOKEN_ROWS,
  );
  if (rawOps.length === 0) throw new Error(`${context}.settlementWorkspace.ops must not be empty`);
  const ops = rawOps.map((op, index) =>
    validateSettlementOp(op, `${context}.settlementWorkspace.ops[${index}]`));
  persistedBoolean(workspace['lastModifiedByLeft'], `${context}.settlementWorkspace.lastModifiedByLeft`);
  persistedEnum(workspace['status'], WORKSPACE_STATUSES, `${context}.settlementWorkspace.status`);
  const revision = persistedUint(workspace['revision'], `${context}.settlementWorkspace.revision`);
  if (revision === 0) throw new Error(`${context}.settlementWorkspace.revision must be positive`);
  persistedUint(workspace['createdAt'], `${context}.settlementWorkspace.createdAt`);
  persistedUint(workspace['lastUpdatedAt'], `${context}.settlementWorkspace.lastUpdatedAt`);
  persistedBoolean(workspace['executorIsLeft'], `${context}.settlementWorkspace.executorIsLeft`);
  for (const field of ['leftHanko', 'rightHanko', 'settlementHash'] as const) {
    persistedOptional(workspace[field], item => persistedHex(item, `${context}.settlementWorkspace.${field}`));
  }
  persistedOptional(workspace['memo'], item => persistedString(item, `${context}.settlementWorkspace.memo`, 256));
  persistedOptional(workspace['nonceAtSign'], item => persistedUint(item, `${context}.settlementWorkspace.nonceAtSign`));
  persistedOptional(
    workspace['postSettlementDisputeProof'],
    item => validatePostSettlementProof(item, `${context}.settlementWorkspace.postSettlementDisputeProof`),
  );

  const compiled = compileOps(ops, workspace['lastModifiedByLeft'] as boolean);
  if (workspace['compiledDiffs'] !== undefined) {
    const diffs = persistedArray(workspace['compiledDiffs'], `${context}.settlementWorkspace.compiledDiffs`, 32)
      .map((diff, index) => validateSettlementDiff(diff, `${context}.settlementWorkspace.compiledDiffs[${index}]`));
    if (safeStringify(diffs) !== safeStringify(compiled.diffs)) {
      throw new Error(`${context}.settlementWorkspace.compiledDiffs mismatch`);
    }
  }
  if (workspace['compiledForgiveTokenIds'] !== undefined) {
    const ids = persistedArray(
      workspace['compiledForgiveTokenIds'],
      `${context}.settlementWorkspace.compiledForgiveTokenIds`,
      32,
    ).map((id, index) => persistedTokenId(id, `${context}.settlementWorkspace.compiledForgiveTokenIds[${index}]`));
    if (safeStringify(ids) !== safeStringify(compiled.forgiveTokenIds)) {
      throw new Error(`${context}.settlementWorkspace.compiledForgiveTokenIds mismatch`);
    }
  }
  assertCanonicalSettlementWorkspace(
    state,
    { ...workspace, ops } as unknown as AccountState['settlementWorkspace'] & object,
  );
};
