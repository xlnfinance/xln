/**
 * Validates the process topology before a production load run starts.
 * Cross-j source and target hubs share one Runtime/WAL; load generation and
 * market making remain separate processes so a crash cannot fake atomicity.
 */

import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary-validation';
import type { ProductionSwapLoadMode } from './schema';

export type ProductionSwapLoadProcess = Readonly<{
  runtimeId: string;
  pid: number;
  walPath: string;
}>;

export type ProductionSwapLoadTopology = Readonly<{
  sourceHub: ProductionSwapLoadProcess;
  targetHub: ProductionSwapLoadProcess;
  loadRuntime: ProductionSwapLoadProcess;
  marketMakerPid: number;
  jurisdictionChainIds: readonly [number, number];
  networking: 'relay-p2p';
  persistence: 'leveldb-wal';
}>;

const RUNTIME_ID = /^0x[0-9a-f]{40}$/;

const decodeProcess = (value: unknown, code: string): ProductionSwapLoadProcess => {
  const record = requireBoundaryRecord(value, `${code}_INVALID`);
  requireExactBoundaryKeys(record, ['runtimeId', 'pid', 'walPath'], [], `${code}_FIELDS_INVALID`);
  const runtimeId = record['runtimeId'];
  const walPath = record['walPath'];
  if (typeof runtimeId !== 'string' || !RUNTIME_ID.test(runtimeId)) throw new Error(`${code}_RUNTIME_ID_INVALID`);
  if (typeof walPath !== 'string' || !walPath.startsWith('/') || walPath.trim() !== walPath) {
    throw new Error(`${code}_WAL_PATH_INVALID`);
  }
  return {
    runtimeId,
    pid: requireBoundaryInteger(record['pid'], `${code}_PID_INVALID`, 1),
    walPath,
  };
};

const requireDistinctProcesses = (topology: ProductionSwapLoadTopology): void => {
  const runtimePids = [topology.sourceHub.pid, topology.targetHub.pid, topology.loadRuntime.pid];
  if (topology.loadRuntime.pid === topology.sourceHub.pid || topology.loadRuntime.pid === topology.targetHub.pid) {
    throw new Error('PRODUCTION_SWAP_LOAD_LOAD_RUNTIME_NOT_SEPARATE');
  }
  if (runtimePids.includes(topology.marketMakerPid)) {
    throw new Error('PRODUCTION_SWAP_LOAD_MARKET_MAKER_NOT_SEPARATE');
  }
};

export const decodeProductionSwapLoadTopology = (
  value: unknown,
  mode: ProductionSwapLoadMode,
): ProductionSwapLoadTopology => {
  const record = requireBoundaryRecord(value, 'PRODUCTION_SWAP_LOAD_TOPOLOGY_INVALID');
  requireExactBoundaryKeys(record, [
    'sourceHub', 'targetHub', 'loadRuntime', 'marketMakerPid',
    'jurisdictionChainIds', 'networking', 'persistence',
  ], [], 'PRODUCTION_SWAP_LOAD_TOPOLOGY_FIELDS_INVALID');
  if (record['networking'] !== 'relay-p2p') throw new Error('PRODUCTION_SWAP_LOAD_NETWORKING_INVALID');
  if (record['persistence'] !== 'leveldb-wal') throw new Error('PRODUCTION_SWAP_LOAD_PERSISTENCE_INVALID');
  const chainIds = record['jurisdictionChainIds'];
  if (!Array.isArray(chainIds) || chainIds.length !== 2) throw new Error('PRODUCTION_SWAP_LOAD_CHAINS_INVALID');
  const topology: ProductionSwapLoadTopology = {
    sourceHub: decodeProcess(record['sourceHub'], 'PRODUCTION_SWAP_LOAD_SOURCE_HUB'),
    targetHub: decodeProcess(record['targetHub'], 'PRODUCTION_SWAP_LOAD_TARGET_HUB'),
    loadRuntime: decodeProcess(record['loadRuntime'], 'PRODUCTION_SWAP_LOAD_RUNTIME'),
    marketMakerPid: requireBoundaryInteger(record['marketMakerPid'], 'PRODUCTION_SWAP_LOAD_MM_PID_INVALID', 1),
    jurisdictionChainIds: [
      requireBoundaryInteger(chainIds[0], 'PRODUCTION_SWAP_LOAD_SOURCE_CHAIN_INVALID', 1),
      requireBoundaryInteger(chainIds[1], 'PRODUCTION_SWAP_LOAD_TARGET_CHAIN_INVALID', 1),
    ],
    networking: 'relay-p2p',
    persistence: 'leveldb-wal',
  };
  if (topology.jurisdictionChainIds[0] === topology.jurisdictionChainIds[1]) {
    throw new Error('PRODUCTION_SWAP_LOAD_CHAINS_NOT_DISTINCT');
  }
  requireDistinctProcesses(topology);
  if (mode !== 'same' && (
    topology.sourceHub.runtimeId !== topology.targetHub.runtimeId ||
    topology.sourceHub.pid !== topology.targetHub.pid ||
    topology.sourceHub.walPath !== topology.targetHub.walPath
  )) throw new Error('PRODUCTION_SWAP_LOAD_CROSS_J_HUBS_NOT_ATOMICALLY_COHOSTED');
  return topology;
};
