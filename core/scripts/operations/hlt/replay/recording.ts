/** Exact H1 checkpoint + Runtime WAL tail used by both HLT phases. */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../protocol/boundary-validation';
import { safeParse, safeStringify, serializeTaggedJson } from '../../../../protocol/serialization';
import {
  validateRuntimeRecoveryBundle,
  type RuntimeRecording,
  type RuntimeRecoveryBundleV1,
} from '../../../../runtime';
import type { PersistedFrameJournal } from '../../../../storage/types';
import type { ConcreteCheckpointSourceExport } from '../../../../storage/read/concrete-checkpoint-source';
import {
  buildHltAuthorityEvidence,
  type HltAuthorityEvidence,
} from './authority-evidence';
import {
  HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM,
  type HltAuthoritySourceBinding,
} from './source-binding';

export const HLT_HUB_RECORDING_SCHEMA = 'xln-hlt-runtime-wal-recording-v1' as const;

export type HltHubRecordingTotals = Readonly<{
  runtimeFrames: number;
  runtimeEntityInputs: number;
  outboxEnvelopes: number;
}>;

export type HltHubRecordingArtifact = Readonly<{
  schema: typeof HLT_HUB_RECORDING_SCHEMA;
  createdAt: number;
  source: Readonly<{
    engine: 'ts';
    workDir: string;
    users: number;
    workload: string;
    binding: HltAuthoritySourceBinding;
  }>;
  checkpoint: ConcreteCheckpointSourceExport;
  tail: RuntimeRecoveryBundleV1;
  authorityEvidence: HltAuthorityEvidence;
}>;

export type HltHubRecording = HltHubRecordingArtifact & Readonly<{
  /** Read-time summary derived from the sole canonical signed WAL tail. */
  totals: HltHubRecordingTotals;
  /** Retired TS replay view; contains the signed tail only and cannot restore. */
  recording: RuntimeRecording;
}>;

export const summarizeHltHubFrames = (
  frames: readonly PersistedFrameJournal[],
): HltHubRecordingTotals => frames.reduce((total, frame) => ({
    runtimeFrames: total.runtimeFrames + 1,
    runtimeEntityInputs: total.runtimeEntityInputs + frame.runtimeInput.entityInputs.length,
    outboxEnvelopes: total.outboxEnvelopes + frame.runtimeOutputCount,
  }), {
  runtimeFrames: 0,
  runtimeEntityInputs: 0,
  outboxEnvelopes: 0,
});

export const recordingFrames = (recording: HltHubRecordingArtifact): PersistedFrameJournal[] =>
  recording.tail.frames ?? [];

const decodeCheckpoint = (value: unknown): ConcreteCheckpointSourceExport => {
  const checkpoint = requireBoundaryRecord(value, 'HLT_HUB_CHECKPOINT_INVALID');
  requireExactBoundaryKeys(
    checkpoint,
    ['height', 'frameBytes', 'rootHash', 'leafCount', 'runtimeMachineLeaves', 'stateRows'],
    [],
    'HLT_HUB_CHECKPOINT',
  );
  const height = Number(checkpoint['height']);
  const leafCount = Number(checkpoint['leafCount']);
  const hex = (field: string, bytes?: number): `0x${string}` => {
    const raw = checkpoint[field];
    if (typeof raw !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(raw) ||
        (bytes !== undefined && raw.length !== 2 + bytes * 2)) {
      throw new Error(`HLT_HUB_CHECKPOINT_HEX_INVALID:${field}`);
    }
    return raw as `0x${string}`;
  };
  const rows = (field: string): readonly (readonly [`0x${string}`, `0x${string}`])[] => {
    const raw = checkpoint[field];
    if (!Array.isArray(raw)) throw new Error(`HLT_HUB_CHECKPOINT_ROWS_INVALID:${field}`);
    let previous = '';
    return raw.map((entry, index) => {
      if (!Array.isArray(entry) || entry.length !== 2 ||
          typeof entry[0] !== 'string' || typeof entry[1] !== 'string' ||
          !/^0x(?:[0-9a-f]{2})+$/.test(entry[0]) || !/^0x(?:[0-9a-f]{2})+$/.test(entry[1]) ||
          entry[0] <= previous) {
        throw new Error(`HLT_HUB_CHECKPOINT_ROW_INVALID:${field}:${index}`);
      }
      previous = entry[0];
      return entry as [`0x${string}`, `0x${string}`];
    });
  };
  if (!Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(leafCount) || leafCount < 1) {
    throw new Error('HLT_HUB_CHECKPOINT_NUMBER_INVALID');
  }
  const runtimeMachineLeaves = rows('runtimeMachineLeaves');
  if (runtimeMachineLeaves.length !== leafCount) throw new Error('HLT_HUB_CHECKPOINT_LEAF_COUNT');
  return {
    height,
    frameBytes: hex('frameBytes'),
    rootHash: hex('rootHash', 32),
    leafCount,
    runtimeMachineLeaves,
    stateRows: rows('stateRows'),
  };
};

const decodeSourceBinding = (value: unknown): HltAuthoritySourceBinding => {
  const binding = requireBoundaryRecord(value, 'HLT_HUB_RECORDING_SOURCE_BINDING_INVALID');
  requireExactBoundaryKeys(
    binding,
    ['algorithm', 'runtimeSeedHash', 'walTreeHash'],
    [],
    'HLT_HUB_RECORDING_SOURCE_BINDING',
  );
  const hash = (field: 'runtimeSeedHash' | 'walTreeHash'): string => {
    const raw = binding[field];
    if (typeof raw !== 'string' || !/^0x[0-9a-f]{64}$/.test(raw)) {
      throw new Error(`HLT_HUB_RECORDING_SOURCE_BINDING_HASH:${field}`);
    }
    return raw;
  };
  if (binding['algorithm'] !== HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM) {
    throw new Error(`HLT_HUB_RECORDING_SOURCE_BINDING_ALGORITHM:${String(binding['algorithm'])}`);
  }
  return {
    algorithm: HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM,
    runtimeSeedHash: hash('runtimeSeedHash'),
    walTreeHash: hash('walTreeHash'),
  };
};

export const validateHltHubRecording = (value: unknown): HltHubRecording => {
  const root = requireBoundaryRecord(value, 'HLT_HUB_RECORDING_INVALID');
  requireExactBoundaryKeys(
    root,
    [
      'schema', 'createdAt', 'source', 'checkpoint', 'tail', 'authorityEvidence',
    ],
    [],
    'HLT_HUB_RECORDING',
  );
  if (root['schema'] !== HLT_HUB_RECORDING_SCHEMA) throw new Error('HLT_HUB_RECORDING_SCHEMA_INVALID');
  const source = requireBoundaryRecord(root['source'], 'HLT_HUB_RECORDING_SOURCE_INVALID');
  requireExactBoundaryKeys(
    source,
    ['engine', 'workDir', 'users', 'workload', 'binding'],
    [],
    'HLT_HUB_RECORDING_SOURCE',
  );
  const checkpoint = decodeCheckpoint(root['checkpoint']);
  const tail = validateRuntimeRecoveryBundle(root['tail']);
  if (tail.kind !== 'journal_tail' || tail.baseRuntimeHeight !== checkpoint.height ||
      tail.baseCheckpointHash !== checkpoint.rootHash) {
    throw new Error('HLT_HUB_RECORDING_CHECKPOINT_TAIL_MISMATCH');
  }
  const frames = tail.frames ?? [];
  const authorityEvidence = buildHltAuthorityEvidence(frames);
  if (safeStringify(root['authorityEvidence']) !== safeStringify(authorityEvidence)) {
    throw new Error('HLT_AUTHORITY_EVIDENCE_MISMATCH');
  }
  const decoded: HltHubRecording = {
    schema: HLT_HUB_RECORDING_SCHEMA,
    createdAt: Number(root['createdAt']),
    source: {
      engine: source['engine'] as 'ts',
      workDir: String(source['workDir'] || ''),
      users: Number(source['users']),
      workload: String(source['workload'] || ''),
      binding: decodeSourceBinding(source['binding']),
    },
    checkpoint,
    tail,
    recording: {
      format: 'xln-runtime-recording',
      version: 1,
      runtimeId: tail.runtimeId,
      baseHeight: checkpoint.height,
      targetHeight: tail.runtimeHeight,
      createdAt: Number(root['createdAt']),
      bundles: [tail],
      bundleHashes: [],
      manifestHash: '',
    },
    totals: summarizeHltHubFrames(frames),
    authorityEvidence,
  };
  if (!Number.isSafeInteger(decoded.createdAt) || decoded.createdAt < 0) throw new Error('HLT_HUB_RECORDING_CREATED_AT_INVALID');
  if (!decoded.source.workDir || !decoded.source.workload || !Number.isSafeInteger(decoded.source.users) || decoded.source.users < 1) {
    throw new Error('HLT_HUB_RECORDING_SOURCE_INVALID');
  }
  if (decoded.source.engine !== 'ts') throw new Error('HLT_HUB_RECORDING_ENGINE_NOT_TS');
  return decoded;
};

export const readHltHubRecording = (path: string): HltHubRecording =>
  validateHltHubRecording(safeParse(readFileSync(path, 'utf8')));

export const writeHltHubRecording = (path: string, recording: HltHubRecordingArtifact): void => {
  const validated = validateHltHubRecording(recording);
  const temporary = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(descriptor, `${serializeTaggedJson({
      schema: validated.schema,
      createdAt: validated.createdAt,
      source: validated.source,
      checkpoint: validated.checkpoint,
      tail: validated.tail,
      authorityEvidence: validated.authorityEvidence,
    })}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
};
