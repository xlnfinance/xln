import type { RoutedEntityInput, RuntimeInput } from '../../types';
import { validateRuntimeInputEnvelope } from '../../protocol/boundary-validation';
import { cloneIsolatedRuntimeSnapshot } from '../../protocol/runtime-input-clone';
import { validateEntityInput } from '../../validation-utils';
import { validateBrowserVmState } from './browser';
import { validateEntityTxs } from './entity-tx';
import { validateJInputs, validateJReplicas } from './j';
import { validateRuntimeTx } from './runtime-tx';
import { validateDurableRuntimeState, validateReliableReceipt } from './runtime-state';
import {
  requireArray,
  requireBoolean,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireFiniteNumber,
  requireMap,
  requireString,
  requireStringArray,
  validateStorageSafeValue,
} from './primitives';

const validateStorageConfig = (value: unknown, code: string): void => {
  const storage = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(storage, [], [
    'enabled', 'snapshotPeriodFrames', 'retainSnapshots', 'epochMaxBytes', 'frameDbMaxBytes',
    'frameDbRetainFrames', 'materializePeriodFrames', 'canonicalHashPeriodFrames', 'accountMerkleRadix',
  ], `${code}_FIELDS`);
  if (storage['enabled'] !== undefined) requireBoolean(storage['enabled'], `${code}_ENABLED`);
  for (const field of [
    'snapshotPeriodFrames', 'retainSnapshots', 'epochMaxBytes', 'frameDbMaxBytes',
    'frameDbRetainFrames', 'materializePeriodFrames', 'canonicalHashPeriodFrames',
  ]) if (storage[field] !== undefined) requireBoundaryInteger(storage[field], `${code}_${field.toUpperCase()}`);
  if (storage['accountMerkleRadix'] !== undefined && storage['accountMerkleRadix'] !== 16 && storage['accountMerkleRadix'] !== 256) {
    throw new Error(`${code}_ACCOUNT_MERKLE_RADIX`);
  }
};

const validateRuntimeConfig = (value: unknown, code: string): void => {
  const config = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(config, [], [
    'minFrameDelayMs', 'loopIntervalMs', 'snapshotIntervalFrames',
    'entityConsensusStateWarningBytes', 'advertiseProfileMirrors', 'storage',
  ], `${code}_FIELDS`);
  for (const field of [
    'minFrameDelayMs', 'loopIntervalMs', 'snapshotIntervalFrames', 'entityConsensusStateWarningBytes',
  ]) if (config[field] !== undefined) requireFiniteNumber(config[field], `${code}_${field.toUpperCase()}`, 0);
  if (config['advertiseProfileMirrors'] !== undefined) {
    requireBoolean(config['advertiseProfileMirrors'], `${code}_ADVERTISE_PROFILE_MIRRORS`);
  }
  if (config['storage'] !== undefined) validateStorageConfig(config['storage'], `${code}_STORAGE`);
};

const validateRoutedEntityInput = (
  value: unknown,
  code: string,
  options: { allowSourceRuntimeFrame?: boolean } = {},
): RoutedEntityInput => {
  const input = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(input, ['entityId', 'signerId'], [
    'runtimeId', 'from', 'certifiedOutputIdentity', 'entityTxs', 'proposedFrame',
    'hashPrecommitFrame', 'hashPrecommits', 'jPrefixAttestations', 'leaderTimeoutVote',
    ...(options.allowSourceRuntimeFrame ? ['sourceRuntimeFrame'] : []),
  ], `${code}_FIELDS`);
  validateEntityInput(input);
  for (const field of ['entityId', 'signerId', 'runtimeId', 'from']) {
    if (input[field] !== undefined) requireString(input[field], `${code}_${field.toUpperCase()}`);
  }
  if (input['certifiedOutputIdentity'] !== undefined) {
    const identity = requireBoundaryRecord(input['certifiedOutputIdentity'], `${code}_OUTPUT_IDENTITY`);
    requireExactBoundaryKeys(identity, ['lane', 'sequence', 'semanticHash'], [], `${code}_OUTPUT_IDENTITY_FIELDS`);
    requireString(identity['lane'], `${code}_OUTPUT_IDENTITY_LANE`);
    if (typeof identity['sequence'] !== 'bigint' || identity['sequence'] < 0n) throw new Error(`${code}_OUTPUT_IDENTITY_SEQUENCE`);
    requireString(identity['semanticHash'], `${code}_OUTPUT_IDENTITY_HASH`);
  }
  if (input['sourceRuntimeFrame'] !== undefined) {
    const frame = requireBoundaryRecord(input['sourceRuntimeFrame'], `${code}_SOURCE_RUNTIME_FRAME`);
    requireExactBoundaryKeys(
      frame,
      ['height', 'timestamp'],
      [],
      `${code}_SOURCE_RUNTIME_FRAME_FIELDS`,
    );
    requireBoundaryInteger(frame['height'], `${code}_SOURCE_RUNTIME_FRAME_HEIGHT`);
    requireBoundaryInteger(frame['timestamp'], `${code}_SOURCE_RUNTIME_FRAME_TIMESTAMP`);
  }
  if (input['entityTxs'] !== undefined) {
    validateEntityTxs(input['entityTxs'], `${code}_ENTITY_TX`);
  }
  if (input['proposedFrame'] !== undefined) {
    validateStorageSafeValue(input['proposedFrame'], `${code}_PROPOSED_FRAME`);
    const proposedFrame = requireBoundaryRecord(input['proposedFrame'], `${code}_PROPOSED_FRAME`);
    validateEntityTxs(proposedFrame['txs'], `${code}_PROPOSED_FRAME_TX`);
  }
  if (input['hashPrecommitFrame'] !== undefined) {
    const frame = requireBoundaryRecord(input['hashPrecommitFrame'], `${code}_HASH_PRECOMMIT_FRAME`);
    requireExactBoundaryKeys(frame, ['height', 'frameHash'], [], `${code}_HASH_PRECOMMIT_FRAME_FIELDS`);
    requireBoundaryInteger(frame['height'], `${code}_HASH_PRECOMMIT_FRAME_HEIGHT`);
    requireString(frame['frameHash'], `${code}_HASH_PRECOMMIT_FRAME_HASH`);
  }
  if (input['hashPrecommits'] !== undefined) {
    for (const [signerId, signatures] of requireMap(input['hashPrecommits'], `${code}_HASH_PRECOMMITS`)) {
      requireString(signerId, `${code}_HASH_PRECOMMITS_SIGNER`);
      requireStringArray(signatures, `${code}_HASH_PRECOMMITS_SIGNATURES`);
    }
  }
  if (input['jPrefixAttestations'] !== undefined) validateStorageSafeValue(input['jPrefixAttestations'], `${code}_J_PREFIX`);
  if (input['leaderTimeoutVote'] !== undefined) validateStorageSafeValue(input['leaderTimeoutVote'], `${code}_LEADER_TIMEOUT`);
  return input as unknown as RoutedEntityInput;
};

const validateRoutedEntityInputs = (
  value: unknown,
  code: string,
  options: { allowSourceRuntimeFrame?: boolean } = {},
): RoutedEntityInput[] => requireArray(value, code)
  .map((entry, index) => validateRoutedEntityInput(entry, `${code}_${index}`, options));

const validateRuntimeInput = (value: unknown, code: string): RuntimeInput => {
  const input = validateRuntimeInputEnvelope(value, code);
  input.entityInputs.forEach((entry, index) => validateRoutedEntityInput(
    entry,
    `${code}_ENTITY_INPUT_${index}`,
    { allowSourceRuntimeFrame: true },
  ));
  if (input.jInputs !== undefined) validateJInputs(input.jInputs, `${code}_J_INPUTS`);
  if (input.reliableReceipts !== undefined) {
    requireArray(input.reliableReceipts, `${code}_RELIABLE_RECEIPTS`).forEach((receipt, index) =>
      validateReliableReceipt(receipt, `${code}_RELIABLE_RECEIPT_${index}`));
  }
  input.runtimeTxs.forEach((tx, index) => validateRuntimeTx(tx, `${code}_RUNTIME_TX_${index}`));
  return input;
};

export const validateDurableRuntimeMachineSnapshot = (
  value: unknown,
  code: string,
): Record<string, unknown> => {
  const snapshot = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(snapshot, ['runtimeInput', 'jReplicas'], [
    'runtimeId', 'activeJurisdiction', 'browserVMState', 'runtimeConfig', 'runtimeState',
    'pendingOutputs', 'networkInbox', 'pendingNetworkOutputs',
  ], `${code}_FIELDS`);
  if (snapshot['runtimeId'] !== undefined) requireString(snapshot['runtimeId'], `${code}_RUNTIME_ID`);
  if (snapshot['activeJurisdiction'] !== undefined) requireString(snapshot['activeJurisdiction'], `${code}_ACTIVE_JURISDICTION`);
  if (snapshot['browserVMState'] !== undefined) validateBrowserVmState(snapshot['browserVMState'], `${code}_BROWSER_VM_STATE`);
  if (snapshot['runtimeConfig'] !== undefined) validateRuntimeConfig(snapshot['runtimeConfig'], `${code}_RUNTIME_CONFIG`);
  if (snapshot['runtimeState'] !== undefined) validateDurableRuntimeState(snapshot['runtimeState'], `${code}_RUNTIME_STATE`);
  validateRuntimeInput(snapshot['runtimeInput'], `${code}_RUNTIME_INPUT`);
  for (const field of ['pendingOutputs', 'networkInbox']) {
    if (snapshot[field] !== undefined) validateRoutedEntityInputs(snapshot[field], `${code}_${field.toUpperCase()}`);
  }
  if (snapshot['pendingNetworkOutputs'] !== undefined) {
    validateRoutedEntityInputs(
      snapshot['pendingNetworkOutputs'],
      `${code}_PENDINGNETWORKOUTPUTS`,
      { allowSourceRuntimeFrame: true },
    );
  }
  validateJReplicas(snapshot['jReplicas'], `${code}_J_REPLICAS`);
  return cloneIsolatedRuntimeSnapshot(snapshot);
};
