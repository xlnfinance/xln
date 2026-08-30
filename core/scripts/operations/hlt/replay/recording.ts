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
  validateRuntimeRecording,
  type RuntimeRecording,
} from '../../../../runtime';
import type { PersistedFrameJournal } from '../../../../storage/types';
import {
  buildHltAuthorityEvidence,
  type HltAuthorityEvidence,
} from './authority-evidence';

export const HLT_HUB_RECORDING_SCHEMA = 'xln-hlt-runtime-wal-recording-v1' as const;

export type HltHubRecordingTotals = Readonly<{
  runtimeFrames: number;
  runtimeEntityInputs: number;
  outboxEnvelopes: number;
}>;

export type HltHubRecording = Readonly<{
  schema: typeof HLT_HUB_RECORDING_SCHEMA;
  createdAt: number;
  source: Readonly<{
    workDir: string;
    users: number;
    workload: string;
  }>;
  recording: RuntimeRecording;
  totals: HltHubRecordingTotals;
  featurePolicy: Readonly<{
    hubRebalance: 'disabled';
    crossJ: 'disabled';
    disputes: 'disabled';
    lending: 'disabled';
  }>;
  authorityEvidence: HltAuthorityEvidence;
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

export const recordingFrames = (recording: RuntimeRecording): PersistedFrameJournal[] =>
  recording.bundles.flatMap(bundle => bundle.kind === 'journal_tail' ? bundle.frames ?? [] : []);

const sameTotals = (left: HltHubRecordingTotals, right: HltHubRecordingTotals): boolean =>
  Object.keys(left).every(key => left[key as keyof HltHubRecordingTotals] === right[key as keyof HltHubRecordingTotals]);

export const validateHltHubRecording = (value: unknown): HltHubRecording => {
  const root = requireBoundaryRecord(value, 'HLT_HUB_RECORDING_INVALID');
  requireExactBoundaryKeys(
    root,
    [
      'schema', 'createdAt', 'source', 'recording', 'totals', 'featurePolicy',
      'authorityEvidence',
    ],
    [],
    'HLT_HUB_RECORDING',
  );
  if (root['schema'] !== HLT_HUB_RECORDING_SCHEMA) throw new Error('HLT_HUB_RECORDING_SCHEMA_INVALID');
  const source = requireBoundaryRecord(root['source'], 'HLT_HUB_RECORDING_SOURCE_INVALID');
  requireExactBoundaryKeys(source, ['workDir', 'users', 'workload'], [], 'HLT_HUB_RECORDING_SOURCE');
  const totals = requireBoundaryRecord(root['totals'], 'HLT_HUB_RECORDING_TOTALS_INVALID');
  requireExactBoundaryKeys(
    totals,
    ['runtimeFrames', 'runtimeEntityInputs', 'outboxEnvelopes'],
    [],
    'HLT_HUB_RECORDING_TOTALS',
  );
  const recording = validateRuntimeRecording(root['recording'] as RuntimeRecording);
  const featurePolicy = requireBoundaryRecord(root['featurePolicy'], 'HLT_AUTHORITY_FEATURE_POLICY_INVALID');
  requireExactBoundaryKeys(
    featurePolicy,
    ['hubRebalance', 'crossJ', 'disputes', 'lending'],
    [],
    'HLT_AUTHORITY_FEATURE_POLICY_FIELDS_INVALID',
  );
  if (
    featurePolicy['hubRebalance'] !== 'disabled' ||
    featurePolicy['crossJ'] !== 'disabled' ||
    featurePolicy['disputes'] !== 'disabled' ||
    featurePolicy['lending'] !== 'disabled'
  ) throw new Error('HLT_AUTHORITY_FEATURE_POLICY_INVALID');
  const authorityEvidence = buildHltAuthorityEvidence(recordingFrames(recording));
  if (safeStringify(root['authorityEvidence']) !== safeStringify(authorityEvidence)) {
    throw new Error('HLT_AUTHORITY_EVIDENCE_MISMATCH');
  }
  const decoded: HltHubRecording = {
    schema: HLT_HUB_RECORDING_SCHEMA,
    createdAt: Number(root['createdAt']),
    source: {
      workDir: String(source['workDir'] || ''),
      users: Number(source['users']),
      workload: String(source['workload'] || ''),
    },
    recording,
    totals: {
      runtimeFrames: Number(totals['runtimeFrames']),
      runtimeEntityInputs: Number(totals['runtimeEntityInputs']),
      outboxEnvelopes: Number(totals['outboxEnvelopes']),
    },
    featurePolicy: {
      hubRebalance: 'disabled',
      crossJ: 'disabled',
      disputes: 'disabled',
      lending: 'disabled',
    },
    authorityEvidence,
  };
  if (!Number.isSafeInteger(decoded.createdAt) || decoded.createdAt < 0) throw new Error('HLT_HUB_RECORDING_CREATED_AT_INVALID');
  if (!decoded.source.workDir || !decoded.source.workload || !Number.isSafeInteger(decoded.source.users) || decoded.source.users < 1) {
    throw new Error('HLT_HUB_RECORDING_SOURCE_INVALID');
  }
  if (!Object.values(decoded.totals).every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('HLT_HUB_RECORDING_TOTALS_INVALID');
  }
  const actualTotals = summarizeHltHubFrames(recordingFrames(recording));
  if (!sameTotals(decoded.totals, actualTotals)) throw new Error('HLT_HUB_RECORDING_TOTALS_MISMATCH');
  return decoded;
};

export const readHltHubRecording = (path: string): HltHubRecording =>
  validateHltHubRecording(safeParse(readFileSync(path, 'utf8')));

export const writeHltHubRecording = (path: string, recording: HltHubRecording): void => {
  const validated = validateHltHubRecording(recording);
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
