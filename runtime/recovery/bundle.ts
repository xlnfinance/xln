import { ethers } from 'ethers';
import { serializeTaggedJson } from '../serialization-utils';
import { buildRuntimeRecoveryCheckpointSnapshot } from '../wal';
import type { Env } from '../types';
import type {
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
} from './types';
import type { PersistedFrameJournal } from '../wal/store';

const RECOVERY_BUNDLE_VERSION = 1;
const MAX_RECOVERY_JOURNAL_FRAMES = 10_000;

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
    kind?: 'snapshot' | 'journal_tail';
    baseCheckpoint?: { height: number; hash: string };
    frames?: PersistedFrameJournal[];
  },
): RuntimeRecoveryBundleV1 => {
  const runtimeId = normalizeRuntimeId(env.runtimeId);
  if (!runtimeId) {
    throw new Error('RECOVERY_BUNDLE_RUNTIME_ID_REQUIRED');
  }
  const signers = options.signers.map(normalizeSigner);
  const base = {
    version: RECOVERY_BUNDLE_VERSION as 1,
    kind: options.kind ?? 'snapshot',
    runtimeId,
    runtimeHeight: Math.max(0, Math.floor(Number(env.height || 0))),
    runtimeTimestamp: Math.max(0, Math.floor(Number(env.timestamp || 0))),
    createdAt: Math.max(0, Math.floor(Number(options.createdAt ?? Date.now()))),
    signers,
    ...(options.meta ? { meta: structuredClone(options.meta) } : {}),
  };

  if (base.kind === 'journal_tail') {
    return validateRuntimeRecoveryBundle({
      ...base,
      baseRuntimeHeight: Math.max(0, Math.floor(Number(options.baseCheckpoint?.height || 0))),
      baseCheckpointHash: String(options.baseCheckpoint?.hash || '').trim().toLowerCase(),
      frames: [...(options.frames || [])].map((frame) => structuredClone(frame)),
    });
  }

  const checkpoint = buildRuntimeRecoveryCheckpointSnapshot(env);
  return validateRuntimeRecoveryBundle({
    ...base,
    kind: 'snapshot',
    checkpoint,
    checkpointHash: computeRuntimeRecoveryCheckpointHash(checkpoint),
  });
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
  const kind = bundle.kind ?? 'snapshot';
  if (kind !== 'snapshot' && kind !== 'journal_tail') {
    throw new Error(`RECOVERY_BUNDLE_KIND_UNSUPPORTED: ${String(kind)}`);
  }
  const runtimeHeight = Math.max(0, Math.floor(Number(bundle.runtimeHeight || 0)));
  if (kind === 'snapshot') {
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
  } else {
    const baseRuntimeHeight = Math.max(0, Math.floor(Number(bundle.baseRuntimeHeight || 0)));
    const baseCheckpointHash = String(bundle.baseCheckpointHash || '').trim().toLowerCase();
    if (baseRuntimeHeight <= 0 || !/^0x[0-9a-f]{64}$/.test(baseCheckpointHash)) {
      throw new Error('RECOVERY_BUNDLE_JOURNAL_BASE_INVALID');
    }
    if (runtimeHeight <= baseRuntimeHeight) {
      throw new Error(`RECOVERY_BUNDLE_JOURNAL_HEIGHT_INVALID: base=${baseRuntimeHeight} runtime=${runtimeHeight}`);
    }
    const frames = Array.isArray(bundle.frames) ? bundle.frames : [];
    if (frames.length <= 0 || frames.length > MAX_RECOVERY_JOURNAL_FRAMES) {
      throw new Error(`RECOVERY_BUNDLE_JOURNAL_FRAME_COUNT_INVALID:${frames.length}`);
    }
    let expectedHeight = baseRuntimeHeight + 1;
    for (const frame of frames) {
      if (!frame || typeof frame !== 'object') throw new Error('RECOVERY_BUNDLE_JOURNAL_FRAME_INVALID');
      const frameHeight = Math.max(0, Math.floor(Number(frame.height || 0)));
      if (frameHeight !== expectedHeight) {
        throw new Error(`RECOVERY_BUNDLE_JOURNAL_FRAME_GAP: expected=${expectedHeight} actual=${frameHeight}`);
      }
      expectedHeight += 1;
    }
    if (frames.at(-1)?.height !== runtimeHeight) {
      throw new Error(`RECOVERY_BUNDLE_JOURNAL_TIP_MISMATCH: tip=${frames.at(-1)?.height ?? 0} runtime=${runtimeHeight}`);
    }
  }
  return {
    ...bundle,
    kind,
    runtimeId,
    runtimeHeight,
    signers: bundle.signers.map(normalizeSigner),
  };
};
