import { LIMITS } from '../config/constants';
import { compileOps } from '../protocol/settlement/operations';
import { safeStringify } from '../protocol/serialization';
import type { AccountState, SettlementDiff, SettlementOp } from '../types/account';
import { assertCanonicalSettlementWorkspace } from './tx/handlers/settle-transition';
import {
  persistedArray,
  persistedBoolean,
  persistedBytes32,
  persistedInt256,
  persistedRecord,
  persistedTokenId,
  persistedUint,
} from './persisted-value-primitives';

const validateSettlementOp = (value: unknown, context: string): SettlementOp => {
  const source = persistedRecord(value, context);
  const tokenId = persistedTokenId(source['tokenId'], `${context}.tokenId`);
  if (source['type'] === 'forgive') return { type: 'forgive', tokenId };
  if (source['type'] === 'r2c' || source['type'] === 'c2r' || source['type'] === 'r2r') {
    const amount = source['amount'];
    if (typeof amount !== 'bigint' || amount <= 0n) throw new Error(`${context}.amount must be positive bigint`);
    return { type: source['type'], tokenId, amount };
  }
  if (source['type'] !== 'rawDiff') throw new Error(`${context}.type is invalid`);
  return {
    type: 'rawDiff',
    tokenId,
    leftDiff: persistedInt256(source['leftDiff'], `${context}.leftDiff`),
    rightDiff: persistedInt256(source['rightDiff'], `${context}.rightDiff`),
    collateralDiff: persistedInt256(source['collateralDiff'], `${context}.collateralDiff`),
    ondeltaDiff: persistedInt256(source['ondeltaDiff'], `${context}.ondeltaDiff`),
  };
};

const validateSettlementDiff = (value: unknown, context: string): SettlementDiff => {
  const diff = persistedRecord(value, context);
  return {
    tokenId: persistedTokenId(diff['tokenId'], `${context}.tokenId`),
    leftDiff: persistedInt256(diff['leftDiff'], `${context}.leftDiff`),
    rightDiff: persistedInt256(diff['rightDiff'], `${context}.rightDiff`),
    collateralDiff: persistedInt256(diff['collateralDiff'], `${context}.collateralDiff`),
    ondeltaDiff: persistedInt256(diff['ondeltaDiff'], `${context}.ondeltaDiff`),
  };
};

export const validatePersistedSettlementWorkspace = (
  state: Pick<AccountState, 'leftEntity' | 'rightEntity'> & Record<string, unknown>,
  context: string,
): void => {
  if (state['settlementWorkspace'] === undefined) return;
  const workspace = persistedRecord(
    state['settlementWorkspace'], `${context}.settlementWorkspace`,
  );
  persistedBytes32(workspace['workspaceHash'], `${context}.settlementWorkspace.workspaceHash`);
  const rawOps = persistedArray(
    workspace['ops'], `${context}.settlementWorkspace.ops`, LIMITS.MAX_ACCOUNT_TOKEN_ROWS,
  );
  if (rawOps.length === 0) throw new Error(`${context}.settlementWorkspace.ops must not be empty`);
  const ops = rawOps.map((op, index) =>
    validateSettlementOp(op, `${context}.settlementWorkspace.ops[${index}]`));
  const byLeft = persistedBoolean(
    workspace['lastModifiedByLeft'], `${context}.settlementWorkspace.lastModifiedByLeft`,
  );
  const revision = persistedUint(workspace['revision'], `${context}.settlementWorkspace.revision`);
  if (revision === 0) throw new Error(`${context}.settlementWorkspace.revision must be positive`);
  persistedUint(workspace['createdAt'], `${context}.settlementWorkspace.createdAt`);
  persistedUint(workspace['lastUpdatedAt'], `${context}.settlementWorkspace.lastUpdatedAt`);
  persistedBoolean(workspace['executorIsLeft'], `${context}.settlementWorkspace.executorIsLeft`);
  if (!['draft', 'awaiting_counterparty', 'ready_to_submit', 'submitted'].includes(String(workspace['status']))) {
    throw new Error(`${context}.settlementWorkspace.status is invalid`);
  }

  const compiled = compileOps(ops, byLeft);
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
    ).map((id, index) => persistedTokenId(
      id,
      `${context}.settlementWorkspace.compiledForgiveTokenIds[${index}]`,
    ));
    if (safeStringify(ids) !== safeStringify(compiled.forgiveTokenIds)) {
      throw new Error(`${context}.settlementWorkspace.compiledForgiveTokenIds mismatch`);
    }
  }
  assertCanonicalSettlementWorkspace(
    state,
    { ...workspace, ops } as NonNullable<AccountState['settlementWorkspace']>,
  );
};
