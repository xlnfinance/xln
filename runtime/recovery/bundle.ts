import { ethers } from 'ethers';
import { serializeTaggedJson } from '../serialization-utils';
import { buildRuntimeCheckpointSnapshot } from '../wal';
import type { Env } from '../types';
import type {
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
} from './types';

const RECOVERY_BUNDLE_VERSION = 1;

const normalizeRuntimeId = (value: unknown): string => String(value || '').trim().toLowerCase();

const normalizeSigner = (signer: RuntimeRecoverySignerV1): RuntimeRecoverySignerV1 => ({
  index: Math.max(0, Math.floor(Number(signer.index || 0))),
  ...(Number.isFinite(Number(signer.derivationIndex))
    ? { derivationIndex: Math.max(0, Math.floor(Number(signer.derivationIndex))) }
    : {}),
  address: String(signer.address || '').trim().toLowerCase(),
  name: String(signer.name || '').trim() || 'Signer',
  ...(signer.entityId ? { entityId: String(signer.entityId).trim().toLowerCase() } : {}),
  ...(signer.jurisdiction ? { jurisdiction: String(signer.jurisdiction).trim() } : {}),
});

export const computeRuntimeRecoveryCheckpointHash = (checkpoint: Record<string, unknown>): string =>
  ethers.keccak256(ethers.toUtf8Bytes(serializeTaggedJson(checkpoint)));

export const computeRuntimeRecoveryBundleHash = (bundle: RuntimeRecoveryBundleV1): string =>
  ethers.keccak256(ethers.toUtf8Bytes(serializeTaggedJson(bundle)));

export const buildRuntimeRecoveryBundle = (
  env: Env,
  options: {
    signers: RuntimeRecoverySignerV1[];
    meta?: RuntimeRecoveryMetaV1;
    createdAt?: number;
  },
): RuntimeRecoveryBundleV1 => {
  const runtimeId = normalizeRuntimeId(env.runtimeId);
  if (!runtimeId) {
    throw new Error('RECOVERY_BUNDLE_RUNTIME_ID_REQUIRED');
  }
  const checkpoint = buildRuntimeCheckpointSnapshot(env);
  const checkpointHash = computeRuntimeRecoveryCheckpointHash(checkpoint);
  const signers = options.signers.map(normalizeSigner);
  return {
    version: RECOVERY_BUNDLE_VERSION,
    runtimeId,
    runtimeHeight: Math.max(0, Math.floor(Number(env.height || 0))),
    runtimeTimestamp: Math.max(0, Math.floor(Number(env.timestamp || 0))),
    createdAt: Math.max(0, Math.floor(Number(options.createdAt ?? Date.now()))),
    signers,
    checkpoint,
    checkpointHash,
    ...(options.meta ? { meta: structuredClone(options.meta) } : {}),
  };
};

export const validateRuntimeRecoveryBundle = (bundle: RuntimeRecoveryBundleV1): RuntimeRecoveryBundleV1 => {
  if (!bundle || bundle.version !== RECOVERY_BUNDLE_VERSION) {
    throw new Error(`RECOVERY_BUNDLE_VERSION_UNSUPPORTED: ${String(bundle?.version ?? 'unknown')}`);
  }
  const runtimeId = normalizeRuntimeId(bundle.runtimeId);
  if (!runtimeId) {
    throw new Error('RECOVERY_BUNDLE_RUNTIME_ID_REQUIRED');
  }
  if (!Array.isArray(bundle.signers) || bundle.signers.length === 0) {
    throw new Error('RECOVERY_BUNDLE_SIGNERS_REQUIRED');
  }
  const checkpoint = bundle.checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object') {
    throw new Error('RECOVERY_BUNDLE_CHECKPOINT_REQUIRED');
  }
  const actualCheckpointHash = computeRuntimeRecoveryCheckpointHash(checkpoint);
  if (actualCheckpointHash !== bundle.checkpointHash) {
    throw new Error(
      `RECOVERY_BUNDLE_CHECKPOINT_HASH_MISMATCH: expected=${bundle.checkpointHash} actual=${actualCheckpointHash}`,
    );
  }
  const checkpointRuntimeId = normalizeRuntimeId((checkpoint as Record<string, unknown>)['runtimeId']);
  if (checkpointRuntimeId && checkpointRuntimeId !== runtimeId) {
    throw new Error(
      `RECOVERY_BUNDLE_RUNTIME_ID_MISMATCH: bundle=${runtimeId} checkpoint=${checkpointRuntimeId}`,
    );
  }
  return {
    ...bundle,
    runtimeId,
    signers: bundle.signers.map(normalizeSigner),
  };
};
