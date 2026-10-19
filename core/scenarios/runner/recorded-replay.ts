import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeInfraDb,
  closeRuntimeDb,
  restoreEnvFromRecoveryBundles,
  replayRecoveryFrameJournals,
} from '../../runtime';
import { TsAccountWorkerAuthority } from '../../runtime/workers/account';
import {
  beginRuntimeParityEvidence,
  discardRuntimeParityEvidence,
  finishRuntimeParityEvidence,
  type RuntimeParityEvidenceCapture,
} from '../../runtime/observability/parity-evidence';
import { computeCanonicalStateHashFromEnv } from '../../storage/canonical-hash';
import { buildRuntimeRecoveryCheckpointSnapshot } from '../../storage/wal/snapshot';
import { validateRuntimeRecording } from '../../storage/recovery/bundle/recording';
import type { RuntimeRecording } from '../../storage/recovery/bundle/types';
import { safeStringify } from '../../protocol/serialization';

export type RecordedFrameEvidence = {
  height: number;
  stateHash: string;
  evidence: RuntimeParityEvidenceCapture;
};

/** All worker counts consume the same accepted inputs, including external submit results. */
export const replayRecordedScenario = async (
  recording: RuntimeRecording,
  runtimeSeed: string,
  workers: number,
  evidenceDirectory: string,
): Promise<RecordedFrameEvidence[]> => {
  const validated = validateRuntimeRecording(recording);
  const snapshot = validated.bundles[0];
  if (!snapshot || snapshot.kind !== 'snapshot') throw new Error('DETERMINISM_CHECKPOINT_MISSING');
  const frames = validated.bundles.slice(1).flatMap(bundle => bundle.frames ?? []);
  if (frames.length !== validated.targetHeight - validated.baseHeight || frames.length === 0) {
    throw new Error('DETERMINISM_COMPLETE_WAL_TAIL_REQUIRED');
  }
  const env = await restoreEnvFromRecoveryBundles([snapshot], {
    runtimeSeed,
    runtimeId: validated.runtimeId,
    targetHeight: validated.baseHeight,
    readOnly: true,
  });
  const authority = new TsAccountWorkerAuthority(env, workers);
  env.accountAuthorityExecutionMode = 'cutover';
  env.accountAuthorityEntityStageProvider = authority.provider;
  env.quietRuntimeLogs = true;
  const evidence: RecordedFrameEvidence[] = [];
  try {
    for (const frame of frames) {
      beginRuntimeParityEvidence(env);
      try {
        // This verifies the recorded live post-state, replica commitment and exact
        // ordered outbox before comparing W1/W4 events, effects and Account roots.
        await replayRecoveryFrameJournals(env, [frame], { verify: true });
        evidence.push({
          height: frame.height,
          stateHash: computeCanonicalStateHashFromEnv(env),
          evidence: finishRuntimeParityEvidence(env),
        });
      } catch (error) {
        writeFileSync(
          join(evidenceDirectory, `w${workers}-frame-${frame.height}-failure.json`),
          safeStringify({
            expected: frame,
            actual: buildRuntimeRecoveryCheckpointSnapshot(env),
            evidence: finishRuntimeParityEvidence(env),
            error: error instanceof Error ? error.message : String(error),
          }),
          { mode: 0o600 },
        );
        throw error;
      }
    }
    writeFileSync(
      join(evidenceDirectory, `w${workers}-final.json`),
      safeStringify(buildRuntimeRecoveryCheckpointSnapshot(env)),
      { mode: 0o600 },
    );
    return evidence;
  } finally {
    discardRuntimeParityEvidence(env);
    await authority.close();
    await closeRuntimeDb(env);
    await closeInfraDb(env);
  }
};

export const recordedEvidenceHash = (evidence: unknown): string =>
  createHash('sha256').update(safeStringify(evidence)).digest('hex');

export const assertRecordedReplaysMatch = (
  expected: RecordedFrameEvidence[],
  actual: RecordedFrameEvidence[],
  evidenceDirectory: string,
): void => {
  for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
    if (recordedEvidenceHash(expected[index]) === recordedEvidenceHash(actual[index])) continue;
    const height = expected[index]?.height ?? actual[index]?.height;
    const path = join(evidenceDirectory, `w1-w4-frame-${height}-divergence.json`);
    writeFileSync(path, safeStringify({ expected: expected[index], actual: actual[index] }), { mode: 0o600 });
    throw new Error(`DETERMINISM_RECORDED_WAL_MISMATCH:height=${height}:evidence=${path}`);
  }
};
