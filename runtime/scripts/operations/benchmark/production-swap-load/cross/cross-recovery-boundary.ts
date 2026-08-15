/** Exact evidence that a settled cross-j route survived a full process restart. */

import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../../protocol/boundary-validation';
import type { LoadFrame } from '../worker-boundary';

export type CrossRecoveryReport = Readonly<{
  schema: 'xln-production-cross-swap-recovery-v1';
  completionAuthority: 'committed_route_descendant_heads_and_process_replacement';
  serverPidBeforeRestart: number;
  serverPidAfterRestart: number;
  loadOrderId: string;
  sourceAmount: string;
  targetAmount: string;
  routeStatus: 'settled';
  hubBeforeRestart: LoadFrame;
  hubAfterRecovery: LoadFrame;
  loadBeforeRestart: LoadFrame;
  loadAfterRecovery: LoadFrame;
}>;

const decodeFrame = (value: unknown, code: string): LoadFrame => {
  const frame = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(frame, ['height', 'canonicalStateHash'], [], `${code}_FIELDS`);
  const canonicalStateHash = frame['canonicalStateHash'];
  if (typeof canonicalStateHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(canonicalStateHash)) {
    throw new Error(`${code}_ROOT`);
  }
  return {
    height: requireBoundaryInteger(frame['height'], `${code}_HEIGHT`, 1),
    canonicalStateHash,
  };
};

const requireDecimal = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error(code);
  return value;
};

export const decodeCrossRecoveryReport = (value: unknown): CrossRecoveryReport => {
  const report = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_INVALID');
  requireExactBoundaryKeys(report, [
    'schema', 'completionAuthority', 'serverPidBeforeRestart', 'serverPidAfterRestart',
    'loadOrderId', 'sourceAmount', 'targetAmount',
    'routeStatus', 'hubBeforeRestart', 'hubAfterRecovery', 'loadBeforeRestart',
    'loadAfterRecovery',
  ], [], 'PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_FIELDS_INVALID');
  if (
    report['schema'] !== 'xln-production-cross-swap-recovery-v1' ||
    report['completionAuthority'] !== 'committed_route_descendant_heads_and_process_replacement' ||
    report['routeStatus'] !== 'settled'
  ) throw new Error('PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_SCHEMA_INVALID');
  const loadOrderId = report['loadOrderId'];
  if (typeof loadOrderId !== 'string' || !loadOrderId.trim()) {
    throw new Error('PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_ORDER_INVALID');
  }
  const hubBeforeRestart = decodeFrame(report['hubBeforeRestart'], 'PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_HUB_BEFORE');
  const hubAfterRecovery = decodeFrame(report['hubAfterRecovery'], 'PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_HUB_AFTER');
  const loadBeforeRestart = decodeFrame(report['loadBeforeRestart'], 'PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_LOAD_BEFORE');
  const loadAfterRecovery = decodeFrame(report['loadAfterRecovery'], 'PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_LOAD_AFTER');
  const serverPidBeforeRestart = requireBoundaryInteger(
    report['serverPidBeforeRestart'],
    'PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_PID_BEFORE',
    1,
  );
  const serverPidAfterRestart = requireBoundaryInteger(
    report['serverPidAfterRestart'],
    'PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_PID_AFTER',
    1,
  );
  if (serverPidBeforeRestart === serverPidAfterRestart) {
    throw new Error('PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_PROCESS_NOT_REPLACED');
  }
  if (
    hubAfterRecovery.height < hubBeforeRestart.height ||
    loadAfterRecovery.height < loadBeforeRestart.height
  ) throw new Error('PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_HEIGHT_REGRESSION');
  if (
    (hubAfterRecovery.height === hubBeforeRestart.height &&
      hubAfterRecovery.canonicalStateHash !== hubBeforeRestart.canonicalStateHash) ||
    (loadAfterRecovery.height === loadBeforeRestart.height &&
      loadAfterRecovery.canonicalStateHash !== loadBeforeRestart.canonicalStateHash)
  ) throw new Error('PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_SAME_HEIGHT_FORK');
  return {
    schema: report['schema'],
    completionAuthority: report['completionAuthority'],
    serverPidBeforeRestart,
    serverPidAfterRestart,
    loadOrderId: loadOrderId.trim(),
    sourceAmount: requireDecimal(report['sourceAmount'], 'PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_SOURCE_AMOUNT_INVALID'),
    targetAmount: requireDecimal(report['targetAmount'], 'PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_TARGET_AMOUNT_INVALID'),
    routeStatus: report['routeStatus'],
    hubBeforeRestart,
    hubAfterRecovery,
    loadBeforeRestart,
    loadAfterRecovery,
  };
};
