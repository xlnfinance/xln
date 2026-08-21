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

import { accountInputProposal } from '../../../../account/consensus/flush';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../protocol/boundary-validation';
import { safeParse, serializeTaggedJson } from '../../../../protocol/serialization';
import {
  validateRuntimeRecording,
  type RuntimeRecording,
} from '../../../../runtime';
import type { EntityTx } from '../../../../types/entity-tx';
import type { PersistedFrameJournal } from '../../../../storage/types';

export const HLT_HUB_RECORDING_SCHEMA = 'xln-hlt-hub-recording-v1' as const;

export type HltHubRecordingTotals = Readonly<{
  runtimeFrames: number;
  runtimeEntityInputs: number;
  accountInputs: number;
  accountTxs: number;
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
}>;

const nestedEntityTxs = (tx: EntityTx): readonly EntityTx[] => {
  // AccountInput is always a raw top-level EntityTx. Certified output bodies
  // are forbidden from carrying it, so replay metrics must not resurrect a
  // compatibility reader for that invalid shape.
  if (tx.type === 'runtimeOutput') return tx.data.entityTxs;
  if (tx.type === 'entityCommand') return tx.data.txs;
  if (tx.type === 'propose' && tx.data.action.type === 'entity_transaction') return tx.data.action.data.txs;
  return [];
};

const countEntityTxWork = (txs: readonly EntityTx[]): { accountInputs: number; accountTxs: number } =>
  txs.reduce((total, tx) => {
    const nested = countEntityTxWork(nestedEntityTxs(tx));
    const proposal = tx.type === 'accountInput' ? accountInputProposal(tx.data) : null;
    return {
      accountInputs: total.accountInputs + nested.accountInputs + (tx.type === 'accountInput' ? 1 : 0),
      accountTxs: total.accountTxs + nested.accountTxs + (proposal?.frame.accountTxs.length ?? 0),
    };
  }, { accountInputs: 0, accountTxs: 0 });

export const summarizeHltHubFrames = (
  frames: readonly PersistedFrameJournal[],
): HltHubRecordingTotals => frames.reduce((total, frame) => {
  const work = frame.runtimeInput.entityInputs.reduce((sum, input) => {
    const counted = countEntityTxWork(input.entityTxs ?? []);
    return {
      accountInputs: sum.accountInputs + counted.accountInputs,
      accountTxs: sum.accountTxs + counted.accountTxs,
    };
  }, { accountInputs: 0, accountTxs: 0 });
  return {
    runtimeFrames: total.runtimeFrames + 1,
    runtimeEntityInputs: total.runtimeEntityInputs + frame.runtimeInput.entityInputs.length,
    accountInputs: total.accountInputs + work.accountInputs,
    accountTxs: total.accountTxs + work.accountTxs,
    outboxEnvelopes: total.outboxEnvelopes + (frame.runtimeOutputRefs?.length ?? 0),
  };
}, {
  runtimeFrames: 0,
  runtimeEntityInputs: 0,
  accountInputs: 0,
  accountTxs: 0,
  outboxEnvelopes: 0,
});

const recordingFrames = (recording: RuntimeRecording): PersistedFrameJournal[] =>
  recording.bundles.flatMap(bundle => bundle.kind === 'journal_tail' ? bundle.frames ?? [] : []);

const sameTotals = (left: HltHubRecordingTotals, right: HltHubRecordingTotals): boolean =>
  Object.keys(left).every(key => left[key as keyof HltHubRecordingTotals] === right[key as keyof HltHubRecordingTotals]);

export const validateHltHubRecording = (value: unknown): HltHubRecording => {
  const root = requireBoundaryRecord(value, 'HLT_HUB_RECORDING_INVALID');
  requireExactBoundaryKeys(root, ['schema', 'createdAt', 'source', 'recording', 'totals'], [], 'HLT_HUB_RECORDING');
  if (root['schema'] !== HLT_HUB_RECORDING_SCHEMA) throw new Error('HLT_HUB_RECORDING_SCHEMA_INVALID');
  const source = requireBoundaryRecord(root['source'], 'HLT_HUB_RECORDING_SOURCE_INVALID');
  requireExactBoundaryKeys(source, ['workDir', 'users', 'workload'], [], 'HLT_HUB_RECORDING_SOURCE');
  const totals = requireBoundaryRecord(root['totals'], 'HLT_HUB_RECORDING_TOTALS_INVALID');
  requireExactBoundaryKeys(
    totals,
    ['runtimeFrames', 'runtimeEntityInputs', 'accountInputs', 'accountTxs', 'outboxEnvelopes'],
    [],
    'HLT_HUB_RECORDING_TOTALS',
  );
  const recording = validateRuntimeRecording(root['recording'] as RuntimeRecording);
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
      accountInputs: Number(totals['accountInputs']),
      accountTxs: Number(totals['accountTxs']),
      outboxEnvelopes: Number(totals['outboxEnvelopes']),
    },
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
