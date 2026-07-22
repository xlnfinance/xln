import { ethers } from 'ethers';

import { serializeTaggedJson } from '../protocol/serialization';
import {
  computeRuntimeRecoveryBundleHash,
  validateRuntimeRecoveryBundle,
} from './bundle';
import type { RuntimeRecording, RuntimeRecoveryBundleV1 } from './types';

type UnsignedRecordingManifest = Omit<RuntimeRecording, 'manifestHash'>;

const recordingManifestHash = (manifest: UnsignedRecordingManifest): string =>
  ethers.keccak256(ethers.toUtf8Bytes(serializeTaggedJson(manifest)));

const validateRecordingBundles = (
  bundles: RuntimeRecoveryBundleV1[],
): { bundles: RuntimeRecoveryBundleV1[]; baseHeight: number; targetHeight: number; runtimeId: string } => {
  const validated = bundles.map(validateRuntimeRecoveryBundle);
  const snapshots = validated.filter(bundle => (bundle.kind ?? 'snapshot') === 'snapshot');
  const tails = validated.filter(bundle => bundle.kind === 'journal_tail');
  if (snapshots.length !== 1 || tails.length > 1) {
    throw new Error(`RUNTIME_RECORDING_BUNDLE_SHAPE_INVALID:snapshots=${snapshots.length}:tails=${tails.length}`);
  }
  const snapshot = snapshots[0]!;
  const tail = tails[0];
  if (tail) {
    if (
      tail.runtimeId !== snapshot.runtimeId
      || tail.baseRuntimeHeight !== snapshot.runtimeHeight
      || tail.baseCheckpointHash !== snapshot.checkpointHash
    ) {
      throw new Error('RUNTIME_RECORDING_TAIL_BASE_MISMATCH');
    }
  }
  return {
    bundles: validated,
    runtimeId: snapshot.runtimeId,
    baseHeight: snapshot.runtimeHeight,
    targetHeight: tail?.runtimeHeight ?? snapshot.runtimeHeight,
  };
};

export const buildRuntimeRecording = (
  bundles: RuntimeRecoveryBundleV1[],
  createdAt = Date.now(),
): RuntimeRecording => {
  const validated = validateRecordingBundles(bundles);
  const unsigned: UnsignedRecordingManifest = {
    format: 'xln-runtime-recording',
    version: 1,
    runtimeId: validated.runtimeId,
    baseHeight: validated.baseHeight,
    targetHeight: validated.targetHeight,
    createdAt: Math.max(0, Math.floor(createdAt)),
    bundles: validated.bundles,
    bundleHashes: validated.bundles.map(computeRuntimeRecoveryBundleHash),
  };
  return { ...unsigned, manifestHash: recordingManifestHash(unsigned) };
};

export const validateRuntimeRecording = (recording: RuntimeRecording): RuntimeRecording => {
  if (recording?.format !== 'xln-runtime-recording' || recording.version !== 1) {
    throw new Error('RUNTIME_RECORDING_FORMAT_UNSUPPORTED');
  }
  const validated = validateRecordingBundles(recording.bundles || []);
  const actualBundleHashes = validated.bundles.map(computeRuntimeRecoveryBundleHash);
  if (
    recording.runtimeId !== validated.runtimeId
    || recording.baseHeight !== validated.baseHeight
    || recording.targetHeight !== validated.targetHeight
    || actualBundleHashes.length !== recording.bundleHashes.length
    || actualBundleHashes.some((hash, index) => hash !== recording.bundleHashes[index])
  ) {
    throw new Error('RUNTIME_RECORDING_MANIFEST_MISMATCH');
  }
  const { manifestHash: _manifestHash, ...unsigned } = recording;
  const actualManifestHash = recordingManifestHash(unsigned);
  if (actualManifestHash !== recording.manifestHash) {
    throw new Error(
      `RUNTIME_RECORDING_MANIFEST_HASH_MISMATCH:expected=${recording.manifestHash}:actual=${actualManifestHash}`,
    );
  }
  return { ...recording, bundles: validated.bundles, bundleHashes: actualBundleHashes };
};
