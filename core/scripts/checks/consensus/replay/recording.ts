/** Recheck an immutable scenario WAL after a change without repeating live setup. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildScenarioIsolatedEnv } from '../../../../scenarios/harness/scenario-isolation';

const argument = (name: string): string => {
  const value = process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!value) throw new Error(`SCENARIO_REPLAY_ARGUMENT_REQUIRED:${name}`);
  return value;
};
const recordingPath = resolve(argument('recording'));
const seed = argument('seed');
const directory = resolve(argument('artifacts'));
const expectedEvidenceHash = argument('expected-evidence-hash');
const dbRoot = mkdtempSync(join(tmpdir(), 'xln-scenario-recheck-'));
process.env = buildScenarioIsolatedEnv(process.env, dbRoot, null);
mkdirSync(directory, { recursive: true, mode: 0o700 });
try {
  // Runtime resolves storage on import. Establish isolation before importing it.
  const { validateRuntimeRecording } = await import('../../../../storage/recovery/bundle/recording');
  const { replayRecordedScenario, assertRecordedReplaysMatch, recordedEvidenceHash } =
    await import('../../../../scenarios/runner/recorded-replay');
  const { safeParse, safeStringify } = await import('../../../../protocol/serialization');
  const recording = validateRuntimeRecording(safeParse(readFileSync(recordingPath, 'utf8')));
  const w1 = await replayRecordedScenario(recording, seed, 1, directory);
  const w4 = await replayRecordedScenario(recording, seed, 4, directory);
  assertRecordedReplaysMatch(w1, w4, directory);
  const evidenceHash = recordedEvidenceHash(w1);
  if (evidenceHash !== expectedEvidenceHash) {
    throw new Error(`SCENARIO_REPLAY_ORIGINAL_EVIDENCE_MISMATCH:${expectedEvidenceHash}:${evidenceHash}`);
  }
  const result = {
    recordingManifestHash: recording.manifestHash,
    frames: w1.length,
    workers: [1, 4],
    finalHash: w1.at(-1)?.stateHash,
    evidenceHash,
  };
  writeFileSync(join(directory, 'result.json'), safeStringify(result, 2));
  console.log(`SCENARIO_RECORDING_RECHECK_GREEN:frames=${w1.length}:evidence=${evidenceHash}`);
} finally {
  rmSync(dbRoot, { recursive: true, force: true });
}
