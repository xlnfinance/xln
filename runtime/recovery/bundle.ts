import { ethers } from 'ethers';
import {
  deriveSignerAddressSync,
  signAccountFrame,
  verifyAccountSignature,
} from '../account/crypto';
import { serializeTaggedJson } from '../protocol/serialization';
import { buildRuntimeRecoveryCheckpointSnapshot } from '../wal';
import type { Env } from '../types';
import type {
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
} from './types';
import type { PersistedFrameJournal } from '../storage/types';

const RECOVERY_BUNDLE_VERSION = 1;
const MAX_RECOVERY_JOURNAL_FRAMES = 10_000;
const RECOVERY_BUNDLE_SIGNATURE_DOMAIN = 'xln:runtime-recovery-bundle:v1';

type UnsignedRuntimeRecoveryBundleV1 = Omit<RuntimeRecoveryBundleV1, 'signature'>;

const normalizeRuntimeId = (value: unknown): string => String(value || '').trim().toLowerCase();

const assertRuntimeMachineBoundToRuntime = (
  machine: Record<string, unknown>,
  runtimeId: string,
  height: number,
  phase: 'pre' | 'post',
): void => {
  const machineRuntimeId = normalizeRuntimeId(machine['runtimeId']);
  if (machineRuntimeId !== runtimeId) {
    throw new Error(
      `RECOVERY_BUNDLE_JOURNAL_RUNTIME_ID_MISMATCH:height=${height}:phase=${phase}:` +
      `bundle=${runtimeId}:machine=${machineRuntimeId || 'missing'}`,
    );
  }
};

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

export const computeRuntimeRecoveryBundleSignatureDigest = (
  bundle: RuntimeRecoveryBundleV1 | UnsignedRuntimeRecoveryBundleV1,
): string => {
  const { signature: _signature, ...unsigned } = bundle as RuntimeRecoveryBundleV1;
  return ethers.keccak256(ethers.toUtf8Bytes(serializeTaggedJson({
    domain: RECOVERY_BUNDLE_SIGNATURE_DOMAIN,
    bundle: unsigned,
  })));
};

const normalizeAndValidateBundleFields = (
  bundle: RuntimeRecoveryBundleV1 | UnsignedRuntimeRecoveryBundleV1,
): UnsignedRuntimeRecoveryBundleV1 => {
  if (!bundle || bundle.version !== RECOVERY_BUNDLE_VERSION) {
    throw new Error(`RECOVERY_BUNDLE_VERSION_UNSUPPORTED: ${String(bundle?.version ?? 'unknown')}`);
  }
  const runtimeId = normalizeRuntimeId(bundle.runtimeId);
  if (!/^0x[0-9a-f]{40}$/.test(runtimeId)) {
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
      // The runtime identity is derived from the locally trusted vault seed.
      // Even a correctly signed recovery tail must not make restore consume a
      // nested identity as authority: signing can faithfully preserve a local
      // persistence bug, while this binding keeps the trust root unambiguous.
      if (frame.runtimeMachine) {
        assertRuntimeMachineBoundToRuntime(frame.runtimeMachine, runtimeId, frameHeight, 'post');
      }
      if (frame.runtimeStateHash !== undefined && !/^0x[0-9a-f]{64}$/i.test(String(frame.runtimeStateHash))) {
        throw new Error(`RECOVERY_BUNDLE_JOURNAL_STATE_HASH_INVALID:height=${frameHeight}`);
      }
      if (!/^0x[0-9a-f]{64}$/i.test(String(frame.replicaMetaDigest || ''))) {
        throw new Error(`RECOVERY_BUNDLE_JOURNAL_REPLICA_META_DIGEST_REQUIRED:height=${frameHeight}`);
      }
      if (!/^0x[0-9a-f]{64}$/i.test(String(frame.postStateHash || ''))) {
        throw new Error(`RECOVERY_BUNDLE_JOURNAL_POST_STATE_HASH_REQUIRED:height=${frameHeight}`);
      }
      if (typeof frame.replicaMetaCheckpoint !== 'boolean') {
        throw new Error(`RECOVERY_BUNDLE_JOURNAL_REPLICA_META_CHECKPOINT_REQUIRED:height=${frameHeight}`);
      }
      if (
        frame.replicaMetaStateMode !== 'live-head' &&
        frame.replicaMetaStateMode !== 'shared-entity-state' &&
        frame.replicaMetaStateMode !== 'full'
      ) {
        throw new Error(`RECOVERY_BUNDLE_JOURNAL_REPLICA_META_STATE_MODE_REQUIRED:height=${frameHeight}`);
      }
      expectedHeight += 1;
    }
    if (frames.at(-1)?.height !== runtimeHeight) {
      throw new Error(`RECOVERY_BUNDLE_JOURNAL_TIP_MISMATCH: tip=${frames.at(-1)?.height ?? 0} runtime=${runtimeHeight}`);
    }
  }
  const { signature: _signature, ...unsigned } = bundle as RuntimeRecoveryBundleV1;
  return {
    ...unsigned,
    kind,
    runtimeId,
    runtimeHeight,
    signers: bundle.signers.map(normalizeSigner),
  };
};

export const validateRuntimeRecoveryBundle = (bundle: RuntimeRecoveryBundleV1): RuntimeRecoveryBundleV1 => {
  const unsigned = normalizeAndValidateBundleFields(bundle);
  const signature = String(bundle.signature || '').trim().toLowerCase();
  const digest = computeRuntimeRecoveryBundleSignatureDigest(unsigned);
  if (!verifyAccountSignature({ quietRuntimeLogs: true }, unsigned.runtimeId, digest, signature)) {
    throw new Error('RECOVERY_BUNDLE_SIGNATURE_INVALID');
  }
  return { ...unsigned, signature };
};

export const assertRuntimeRecoveryBundleAuthenticity = (
  bundle: RuntimeRecoveryBundleV1,
  runtimeSeed: string,
  expectedRuntimeId?: string | null,
): RuntimeRecoveryBundleV1 => {
  if (!runtimeSeed) throw new Error('RECOVERY_BUNDLE_TRUSTED_SEED_REQUIRED');
  const trustedRuntimeId = deriveSignerAddressSync(runtimeSeed, '1').toLowerCase();
  const requestedRuntimeId = normalizeRuntimeId(expectedRuntimeId);
  if (requestedRuntimeId && requestedRuntimeId !== trustedRuntimeId) {
    throw new Error(
      `RECOVERY_BUNDLE_TRUSTED_RUNTIME_ID_MISMATCH:derived=${trustedRuntimeId}:requested=${requestedRuntimeId}`,
    );
  }
  const validated = validateRuntimeRecoveryBundle(bundle);
  if (validated.runtimeId !== trustedRuntimeId) {
    throw new Error(
      `RECOVERY_BUNDLE_TRUSTED_RUNTIME_ID_MISMATCH:derived=${trustedRuntimeId}:bundle=${validated.runtimeId}`,
    );
  }
  return validated;
};

const signRuntimeRecoveryBundle = (
  env: Env,
  bundle: UnsignedRuntimeRecoveryBundleV1,
): RuntimeRecoveryBundleV1 => {
  if (env.runtimeSeed === undefined || env.runtimeSeed === null || env.runtimeSeed === '') {
    throw new Error('RECOVERY_BUNDLE_TRUSTED_SEED_REQUIRED');
  }
  const unsigned = normalizeAndValidateBundleFields(bundle);
  const trustedRuntimeId = deriveSignerAddressSync(env.runtimeSeed, '1').toLowerCase();
  if (unsigned.runtimeId !== trustedRuntimeId) {
    throw new Error(
      `RECOVERY_BUNDLE_RUNTIME_SIGNER_MISMATCH:derived=${trustedRuntimeId}:runtime=${unsigned.runtimeId}`,
    );
  }
  const signature = signAccountFrame(
    env,
    '1',
    computeRuntimeRecoveryBundleSignatureDigest(unsigned),
  );
  return validateRuntimeRecoveryBundle({ ...unsigned, signature });
};

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
    return signRuntimeRecoveryBundle(env, {
      ...base,
      baseRuntimeHeight: Math.max(0, Math.floor(Number(options.baseCheckpoint?.height || 0))),
      baseCheckpointHash: String(options.baseCheckpoint?.hash || '').trim().toLowerCase(),
      frames: [...(options.frames || [])].map((frame) => structuredClone(frame)),
    });
  }

  const checkpoint = buildRuntimeRecoveryCheckpointSnapshot(env);
  return signRuntimeRecoveryBundle(env, {
    ...base,
    kind: 'snapshot',
    checkpoint,
    checkpointHash: computeRuntimeRecoveryCheckpointHash(checkpoint),
  });
};

export const buildRuntimeRecoveryCheckpointBundle = (
  env: Env,
  options: {
    checkpoint: Record<string, unknown>;
    signers: RuntimeRecoverySignerV1[];
    meta?: RuntimeRecoveryMetaV1;
    createdAt?: number;
  },
): RuntimeRecoveryBundleV1 => {
  const runtimeId = normalizeRuntimeId(env.runtimeId);
  const checkpoint = structuredClone(options.checkpoint);
  const checkpointRuntimeId = normalizeRuntimeId(checkpoint['runtimeId']);
  if (!runtimeId || checkpointRuntimeId !== runtimeId) {
    throw new Error(
      `RECOVERY_BUNDLE_RUNTIME_ID_MISMATCH:bundle=${runtimeId || 'missing'}:` +
      `checkpoint=${checkpointRuntimeId || 'missing'}`,
    );
  }
  const runtimeHeight = Number(checkpoint['height']);
  const runtimeTimestamp = Number(checkpoint['timestamp']);
  if (
    !Number.isSafeInteger(runtimeHeight)
    || runtimeHeight < 0
    || runtimeHeight > Math.floor(Number(env.height || 0))
  ) {
    throw new Error(`RECOVERY_BUNDLE_CHECKPOINT_HEIGHT_INVALID:${String(checkpoint['height'])}`);
  }
  if (!Number.isSafeInteger(runtimeTimestamp) || runtimeTimestamp < 0) {
    throw new Error(`RECOVERY_BUNDLE_CHECKPOINT_TIMESTAMP_INVALID:${String(checkpoint['timestamp'])}`);
  }
  return signRuntimeRecoveryBundle(env, {
    version: RECOVERY_BUNDLE_VERSION,
    kind: 'snapshot',
    runtimeId,
    runtimeHeight,
    runtimeTimestamp,
    createdAt: Math.max(0, Math.floor(Number(options.createdAt ?? Date.now()))),
    signers: options.signers.map(normalizeSigner),
    ...(options.meta ? { meta: structuredClone(options.meta) } : {}),
    checkpoint,
    checkpointHash: computeRuntimeRecoveryCheckpointHash(checkpoint),
  });
};
