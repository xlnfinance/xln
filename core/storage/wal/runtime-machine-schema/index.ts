import type { RuntimeReplica } from '../../../runtime/types';
import { toRuntimeId } from '../../../protocol/identity';
import { validateBrowserVmState } from '../../../runtime/decode/browser';
import { validateJReplicas } from './j';
import { validateDurableRuntimeState } from './runtime-state';
import {
  requireBoolean,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireFiniteNumber,
  requireString,
} from '../../../protocol/boundary/boundary-primitives';

const validateStorageConfig = (value: unknown, code: string): void => {
  const storage = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(storage, [], [
    'enabled', 'snapshotPeriodFrames', 'retainSnapshots', 'epochMaxBytes',
    'materializePeriodFrames', 'canonicalHashPeriodFrames', 'accountMerkleRadix',
  ], `${code}_FIELDS`);
  if (storage['enabled'] !== undefined) requireBoolean(storage['enabled'], `${code}_ENABLED`);
  for (const field of [
    'snapshotPeriodFrames', 'retainSnapshots', 'epochMaxBytes',
    'materializePeriodFrames', 'canonicalHashPeriodFrames',
  ]) if (storage[field] !== undefined) requireBoundaryInteger(storage[field], `${code}_${field.toUpperCase()}`);
  if (storage['accountMerkleRadix'] !== undefined && storage['accountMerkleRadix'] !== 16 && storage['accountMerkleRadix'] !== 256) {
    throw new Error(`${code}_ACCOUNT_MERKLE_RADIX`);
  }
};

export const decodeRuntimeConfig = (
  value: unknown,
  code: string,
): RuntimeReplica['runtimeConfig'] => {
  const config = requireBoundaryRecord(value, code);
  // `snapshotIntervalFrames` decided nothing and is no longer produced, but a
  // Runtime restored from a checkpoint written before its removal keeps it —
  // here and in every snapshot that Runtime writes afterwards. That is
  // deliberate: the runtime machine hash covers this config, so dropping the
  // field changes the hash and every journal recorded before the removal stops
  // replaying. Retiring it for existing databases is an explicit offline
  // migration, not something a decoder does quietly under a running node.
  // New Runtimes never have it.
  requireExactBoundaryKeys(config, [], [
    'minFrameDelayMs', 'loopIntervalMs', 'snapshotIntervalFrames',
    'entityConsensusStateWarningBytes', 'advertiseProfileMirrors', 'performance', 'storage',
  ], `${code}_FIELDS`);
  for (const field of [
    'minFrameDelayMs', 'loopIntervalMs', 'snapshotIntervalFrames', 'entityConsensusStateWarningBytes',
  ]) if (config[field] !== undefined) requireFiniteNumber(config[field], `${code}_${field.toUpperCase()}`, 0);
  if (config['advertiseProfileMirrors'] !== undefined) {
    requireBoolean(config['advertiseProfileMirrors'], `${code}_ADVERTISE_PROFILE_MIRRORS`);
  }
  if (config['performance'] !== undefined) {
    const performance = requireBoundaryRecord(config['performance'], `${code}_PERFORMANCE`);
    requireExactBoundaryKeys(performance, [], [
      'maxCloneBytes', 'maxCloneMs', 'maxReducerMs', 'maxWalMs',
    ], `${code}_PERFORMANCE_FIELDS`);
    for (const field of ['maxCloneBytes', 'maxCloneMs', 'maxReducerMs', 'maxWalMs']) {
      if (performance[field] !== undefined) {
        requireFiniteNumber(performance[field], `${code}_PERFORMANCE_${field.toUpperCase()}`, 0);
      }
    }
  }
  if (config['storage'] !== undefined) validateStorageConfig(config['storage'], `${code}_STORAGE`);
  return structuredClone(config) as RuntimeReplica['runtimeConfig'];
};

export const validateDurableRuntimeMachineSnapshot = (
  value: unknown,
  code: string,
): Record<string, unknown> => {
  const snapshot = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(snapshot, ['jReplicas'], [
    'runtimeId', 'activeJurisdiction', 'browserVMState', 'runtimeConfig', 'infrastructure',
  ], `${code}_FIELDS`);
  if (snapshot['runtimeId'] !== undefined) {
    toRuntimeId(requireString(snapshot['runtimeId'], `${code}_RUNTIME_ID`));
  }
  if (snapshot['activeJurisdiction'] !== undefined) requireString(snapshot['activeJurisdiction'], `${code}_ACTIVE_JURISDICTION`);
  if (snapshot['browserVMState'] !== undefined) validateBrowserVmState(snapshot['browserVMState'], `${code}_BROWSER_VM_STATE`);
  if (snapshot['runtimeConfig'] !== undefined) decodeRuntimeConfig(snapshot['runtimeConfig'], `${code}_RUNTIME_CONFIG`);
  if (snapshot['infrastructure'] !== undefined) validateDurableRuntimeState(snapshot['infrastructure'], `${code}_RUNTIME_STATE`);
  validateJReplicas(snapshot['jReplicas'], `${code}_J_REPLICAS`);
  return snapshot;
};
