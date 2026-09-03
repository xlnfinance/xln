/** Hydrate a compact HLT manifest from its sole canonical Runtime WAL. */

import { Level } from 'level';

import { safeStringify } from '../../../../protocol/serialization';
import { validateRuntimeRecoveryBundle } from '../../../../storage/recovery/bundle';
import { buildRuntimeRecording } from '../../../../storage/recovery/bundle/recording';
import type {
  RuntimeRecording,
  RuntimeRecoveryBundleV1,
} from '../../../../storage/recovery/bundle/types';
import { buildRecoveryJournalFromStorageFrame } from '../../../../storage/queries/history';
import {
  readStorageFramePayloads,
  readStorageFrameRecord,
  readStorageHead,
} from '../../../../storage/read/read';
import type { PersistedFrameJournal } from '../../../../storage/types';
import { buildHltAuthorityEvidence } from './authority-evidence';
import {
  readHltHubRecordingManifest,
  type HltHubRecordingArtifact,
} from './recording';

export type HltHubRecording = Omit<HltHubRecordingArtifact, 'tail'> & Readonly<{
  tail: RuntimeRecoveryBundleV1;
  recording: RuntimeRecording;
}>;

export const summarizeHltHubFrames = (
  frames: readonly PersistedFrameJournal[],
): HltHubRecordingArtifact['totals'] => frames.reduce((total, frame) => ({
  runtimeFrames: total.runtimeFrames + 1,
  runtimeEntityInputs: total.runtimeEntityInputs + frame.runtimeInput.entityInputs.length,
  outboxEnvelopes: total.outboxEnvelopes + frame.runtimeOutputCount,
}), { runtimeFrames: 0, runtimeEntityInputs: 0, outboxEnvelopes: 0 });

const readWalFrames = async (
  walPath: string,
  fromHeight: number,
  toHeight: number,
): Promise<PersistedFrameJournal[]> => {
  const db = new Level<Buffer, Buffer>(walPath, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    createIfMissing: false,
  });
  try {
    const head = await readStorageHead(db);
    if (!head || head.latestHeight < toHeight) {
      throw new Error(`HLT_HUB_RECORDING_WAL_HEAD:${String(head?.latestHeight ?? 'missing')}:${toHeight}`);
    }
    const frames: PersistedFrameJournal[] = [];
    for (let height = fromHeight; height <= toHeight; height += 1) {
      const frame = await readStorageFrameRecord(db, height);
      if (!frame) throw new Error(`HLT_HUB_RECORDING_WAL_FRAME_MISSING:${height}`);
      const payloads = await readStorageFramePayloads(db, frame, { includeRuntimeMachine: false });
      frames.push(buildRecoveryJournalFromStorageFrame(frame, payloads));
    }
    return frames;
  } finally {
    await db.close();
  }
};

export const loadHltHubRecording = async (
  recordingPath: string,
  walPath: string,
): Promise<HltHubRecording> => {
  const artifact = readHltHubRecordingManifest(recordingPath);
  const frames = await readWalFrames(
    walPath,
    artifact.tail.baseRuntimeHeight + 1,
    artifact.tail.runtimeHeight,
  );
  const totals = summarizeHltHubFrames(frames);
  if (safeStringify(totals) !== safeStringify(artifact.totals)) {
    throw new Error('HLT_HUB_RECORDING_WAL_TOTALS_MISMATCH');
  }
  const authorityEvidence = buildHltAuthorityEvidence(frames);
  if (safeStringify(authorityEvidence) !== safeStringify(artifact.authorityEvidence)) {
    throw new Error('HLT_AUTHORITY_EVIDENCE_MISMATCH');
  }
  const tail = validateRuntimeRecoveryBundle({ ...artifact.tail, frames });
  const recording = buildRuntimeRecording([artifact.snapshot, tail], artifact.createdAt);
  if (recording.manifestHash !== artifact.runtimeRecordingManifestHash) {
    throw new Error(
      `HLT_RUNTIME_RECORDING_MANIFEST_HASH_MISMATCH:` +
      `${artifact.runtimeRecordingManifestHash}:${recording.manifestHash}`,
    );
  }
  return { ...artifact, tail, recording };
};
