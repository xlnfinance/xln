/** Compact, portable HLT manifest. Runtime frames remain canonical in the bound WAL. */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, normalize } from 'node:path';

import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../protocol/boundary-validation';
import { safeParse, serializeTaggedJson } from '../../../../protocol/serialization';
import { validateRuntimeRecoveryBundle } from '../../../../storage/recovery/bundle';
import type { RuntimeRecoveryBundleV1 } from '../../../../storage/recovery/bundle/types';
import type { ConcreteCheckpointSourceExport } from '../../../../storage/read/concrete-checkpoint-source';
import type { HltAuthorityEvidence } from './authority-evidence';
import {
  HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM,
  type HltAuthoritySourceBinding,
} from './source-binding';

export const HLT_HUB_RECORDING_SCHEMA = 'xln-hlt-runtime-wal-manifest-v2' as const;

export type HltHubRecordingTotals = Readonly<{
  runtimeFrames: number;
  runtimeEntityInputs: number;
  outboxEnvelopes: number;
}>;

export type HltHubRecordingTail = Omit<RuntimeRecoveryBundleV1, 'frames' | 'kind' | 'meta'> & Readonly<{
  kind: 'journal_tail';
  baseRuntimeHeight: number;
  baseCheckpointHash: string;
  meta?: NonNullable<RuntimeRecoveryBundleV1['meta']>;
}>;

export type HltHubRecordingArtifact = Readonly<{
  schema: typeof HLT_HUB_RECORDING_SCHEMA;
  createdAt: number;
  source: Readonly<{
    engine: 'ts';
    hubWalDir: string;
    meshSeedFile: string;
    users: number;
    workload: string;
    binding: HltAuthoritySourceBinding;
  }>;
  snapshot: RuntimeRecoveryBundleV1;
  checkpoint: ConcreteCheckpointSourceExport;
  tail: HltHubRecordingTail;
  totals: HltHubRecordingTotals;
  runtimeRecordingManifestHash: string;
  authorityEvidence: HltAuthorityEvidence;
}>;

const integer = (value: unknown, label: string, minimum = 0): number => {
  const decoded = Number(value);
  if (!Number.isSafeInteger(decoded) || decoded < minimum) throw new Error(`${label}:${String(value)}`);
  return decoded;
};

const hash = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label}:${String(value)}`);
  }
  return value;
};

const relativePath = (value: unknown, label: string): string => {
  const decoded = String(value ?? '').trim();
  const normalized = normalize(decoded);
  if (!decoded || isAbsolute(decoded) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label}:${decoded || 'missing'}`);
  }
  return normalized;
};

const decodeRows = (
  value: unknown,
  field: string,
): readonly (readonly [`0x${string}`, `0x${string}`])[] => {
  if (!Array.isArray(value)) throw new Error(`HLT_HUB_CHECKPOINT_ROWS_INVALID:${field}`);
  let previous = '';
  return value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2 ||
        typeof entry[0] !== 'string' || typeof entry[1] !== 'string' ||
        !/^0x(?:[0-9a-f]{2})+$/.test(entry[0]) || !/^0x(?:[0-9a-f]{2})+$/.test(entry[1]) ||
        entry[0] <= previous) throw new Error(`HLT_HUB_CHECKPOINT_ROW_INVALID:${field}:${index}`);
    previous = entry[0];
    return entry as [`0x${string}`, `0x${string}`];
  });
};

const decodeCheckpoint = (value: unknown): ConcreteCheckpointSourceExport => {
  const checkpoint = requireBoundaryRecord(value, 'HLT_HUB_CHECKPOINT_INVALID');
  requireExactBoundaryKeys(
    checkpoint,
    ['height', 'frameBytes', 'rootHash', 'leafCount', 'runtimeMachineLeaves', 'stateRows'],
    [],
    'HLT_HUB_CHECKPOINT',
  );
  const hex = (field: string, bytes?: number): `0x${string}` => {
    const raw = checkpoint[field];
    if (typeof raw !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(raw) ||
        (bytes !== undefined && raw.length !== 2 + bytes * 2)) {
      throw new Error(`HLT_HUB_CHECKPOINT_HEX_INVALID:${field}`);
    }
    return raw as `0x${string}`;
  };
  const height = integer(checkpoint['height'], 'HLT_HUB_CHECKPOINT_HEIGHT', 1);
  const leafCount = integer(checkpoint['leafCount'], 'HLT_HUB_CHECKPOINT_LEAF_COUNT', 1);
  const runtimeMachineLeaves = decodeRows(checkpoint['runtimeMachineLeaves'], 'runtimeMachineLeaves');
  if (runtimeMachineLeaves.length !== leafCount) throw new Error('HLT_HUB_CHECKPOINT_LEAF_COUNT_MISMATCH');
  return {
    height,
    frameBytes: hex('frameBytes'),
    rootHash: hex('rootHash', 32),
    leafCount,
    runtimeMachineLeaves,
    stateRows: decodeRows(checkpoint['stateRows'], 'stateRows'),
  };
};

const decodeBinding = (value: unknown): HltAuthoritySourceBinding => {
  const binding = requireBoundaryRecord(value, 'HLT_HUB_RECORDING_SOURCE_BINDING_INVALID');
  requireExactBoundaryKeys(binding, ['algorithm', 'runtimeSeedHash', 'walTreeHash'], [], 'HLT_HUB_RECORDING_SOURCE_BINDING');
  if (binding['algorithm'] !== HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM) {
    throw new Error(`HLT_HUB_RECORDING_SOURCE_BINDING_ALGORITHM:${String(binding['algorithm'])}`);
  }
  return {
    algorithm: HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM,
    runtimeSeedHash: hash(binding['runtimeSeedHash'], 'HLT_HUB_RECORDING_RUNTIME_SEED_HASH'),
    walTreeHash: hash(binding['walTreeHash'], 'HLT_HUB_RECORDING_WAL_TREE_HASH'),
  };
};

const decodeTail = (value: unknown): HltHubRecordingTail => {
  const tail = requireBoundaryRecord(value, 'HLT_HUB_RECORDING_TAIL_INVALID');
  requireExactBoundaryKeys(
    tail,
    ['version', 'kind', 'runtimeId', 'runtimeHeight', 'runtimeTimestamp', 'createdAt', 'signers',
      'baseRuntimeHeight', 'baseCheckpointHash', 'signature'],
    ['meta'],
    'HLT_HUB_RECORDING_TAIL',
  );
  if (tail['version'] !== 1 || tail['kind'] !== 'journal_tail' || !Array.isArray(tail['signers'])) {
    throw new Error('HLT_HUB_RECORDING_TAIL_SHAPE');
  }
  const runtimeId = String(tail['runtimeId'] ?? '').toLowerCase();
  const signature = String(tail['signature'] ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(runtimeId) || !/^0x[0-9a-f]+$/.test(signature)) {
    throw new Error('HLT_HUB_RECORDING_TAIL_IDENTITY');
  }
  return {
    version: 1,
    kind: 'journal_tail',
    runtimeId,
    runtimeHeight: integer(tail['runtimeHeight'], 'HLT_HUB_RECORDING_TAIL_HEIGHT'),
    runtimeTimestamp: integer(tail['runtimeTimestamp'], 'HLT_HUB_RECORDING_TAIL_TIMESTAMP'),
    createdAt: integer(tail['createdAt'], 'HLT_HUB_RECORDING_TAIL_CREATED_AT'),
    signers: structuredClone(tail['signers']) as RuntimeRecoveryBundleV1['signers'],
    baseRuntimeHeight: integer(tail['baseRuntimeHeight'], 'HLT_HUB_RECORDING_TAIL_BASE'),
    baseCheckpointHash: hash(tail['baseCheckpointHash'], 'HLT_HUB_RECORDING_TAIL_BASE_HASH'),
    signature,
    ...(tail['meta'] === undefined ? {} : {
      meta: structuredClone(tail['meta']) as NonNullable<RuntimeRecoveryBundleV1['meta']>,
    }),
  };
};

const decodeTotals = (value: unknown): HltHubRecordingTotals => {
  const totals = requireBoundaryRecord(value, 'HLT_HUB_RECORDING_TOTALS_INVALID');
  requireExactBoundaryKeys(totals, ['runtimeFrames', 'runtimeEntityInputs', 'outboxEnvelopes'], [], 'HLT_HUB_RECORDING_TOTALS');
  return {
    runtimeFrames: integer(totals['runtimeFrames'], 'HLT_HUB_RECORDING_TOTAL_FRAMES', 1),
    runtimeEntityInputs: integer(totals['runtimeEntityInputs'], 'HLT_HUB_RECORDING_TOTAL_INPUTS'),
    outboxEnvelopes: integer(totals['outboxEnvelopes'], 'HLT_HUB_RECORDING_TOTAL_OUTBOX'),
  };
};

const decodeEvidence = (value: unknown, frames: number): HltAuthorityEvidence => {
  const root = requireBoundaryRecord(value, 'HLT_AUTHORITY_EVIDENCE_INVALID');
  requireExactBoundaryKeys(root, ['expectations'], [], 'HLT_AUTHORITY_EVIDENCE');
  const expectations = requireBoundaryRecord(root['expectations'], 'HLT_AUTHORITY_EXPECTATIONS_INVALID');
  requireExactBoundaryKeys(expectations, ['runtimeFrames', 'effects'], [], 'HLT_AUTHORITY_EXPECTATIONS');
  if (!Array.isArray(expectations['runtimeFrames']) || !Array.isArray(expectations['effects']) ||
      expectations['runtimeFrames'].length !== frames || expectations['effects'].length !== frames) {
    throw new Error('HLT_AUTHORITY_EVIDENCE_FRAME_COUNT_MISMATCH');
  }
  return structuredClone(root) as HltAuthorityEvidence;
};

export const validateHltHubRecordingManifest = (value: unknown): HltHubRecordingArtifact => {
  const root = requireBoundaryRecord(value, 'HLT_HUB_RECORDING_INVALID');
  if (root['schema'] !== HLT_HUB_RECORDING_SCHEMA) {
    throw new Error(`HLT_HUB_RECORDING_SCHEMA_UNSUPPORTED:${String(root['schema'])}`);
  }
  requireExactBoundaryKeys(
    root,
    ['schema', 'createdAt', 'source', 'snapshot', 'checkpoint', 'tail', 'totals',
      'runtimeRecordingManifestHash', 'authorityEvidence'],
    [],
    'HLT_HUB_RECORDING',
  );
  const source = requireBoundaryRecord(root['source'], 'HLT_HUB_RECORDING_SOURCE_INVALID');
  requireExactBoundaryKeys(source, ['engine', 'hubWalDir', 'meshSeedFile', 'users', 'workload', 'binding'], [], 'HLT_HUB_RECORDING_SOURCE');
  if (source['engine'] !== 'ts') throw new Error('HLT_HUB_RECORDING_ENGINE_NOT_TS');
  const snapshot = validateRuntimeRecoveryBundle(root['snapshot']);
  const checkpoint = decodeCheckpoint(root['checkpoint']);
  const tail = decodeTail(root['tail']);
  const totals = decodeTotals(root['totals']);
  if (snapshot.kind !== 'snapshot' || snapshot.runtimeHeight !== checkpoint.height ||
      tail.runtimeId !== snapshot.runtimeId || tail.baseRuntimeHeight !== checkpoint.height ||
      tail.baseCheckpointHash !== snapshot.checkpointHash ||
      tail.runtimeHeight - tail.baseRuntimeHeight !== totals.runtimeFrames) {
    throw new Error('HLT_HUB_RECORDING_CHECKPOINT_TAIL_MISMATCH');
  }
  const workload = String(source['workload'] ?? '').trim();
  if (!workload) throw new Error('HLT_HUB_RECORDING_WORKLOAD_MISSING');
  return {
    schema: HLT_HUB_RECORDING_SCHEMA,
    createdAt: integer(root['createdAt'], 'HLT_HUB_RECORDING_CREATED_AT'),
    source: {
      engine: 'ts',
      hubWalDir: relativePath(source['hubWalDir'], 'HLT_HUB_RECORDING_WAL_PATH'),
      meshSeedFile: relativePath(source['meshSeedFile'], 'HLT_HUB_RECORDING_SEED_PATH'),
      users: integer(source['users'], 'HLT_HUB_RECORDING_USERS', 1),
      workload,
      binding: decodeBinding(source['binding']),
    },
    snapshot,
    checkpoint,
    tail,
    totals,
    runtimeRecordingManifestHash: hash(root['runtimeRecordingManifestHash'], 'HLT_HUB_RECORDING_MANIFEST_HASH'),
    authorityEvidence: decodeEvidence(root['authorityEvidence'], totals.runtimeFrames),
  };
};

export const readHltHubRecordingManifest = (path: string): HltHubRecordingArtifact =>
  validateHltHubRecordingManifest(safeParse(readFileSync(path, 'utf8')));

export const resolveHltHubRecordingPath = (recordingPath: string, relative: string): string =>
  normalize(`${dirname(recordingPath)}/${relative}`);

export const writeHltHubRecording = (path: string, artifact: HltHubRecordingArtifact): void => {
  const validated = validateHltHubRecordingManifest(artifact);
  const temporary = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(descriptor, `${serializeTaggedJson(validated)}\n`);
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
