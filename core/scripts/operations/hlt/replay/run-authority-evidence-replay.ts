#!/usr/bin/env bun

/** Rust-only Account authority replay against one exact TS H1 recording. */

import { resolve } from 'node:path';

import {
  authorityEvidenceBinary,
  runAuthorityEvidenceGate,
} from './authority-evidence-gate-support';
import { writeAuthorityReplayPreflight } from './authority-replay-preflight';

const recordingRaw = String(process.env['XLN_RSCORE_EVIDENCE_RECORDING'] ?? '').trim();
if (!recordingRaw) throw new Error('RSCORE_EVIDENCE_RECORDING_MISSING');
const recording = resolve(recordingRaw);
const output = resolve(String(
  process.env['XLN_RSCORE_EVIDENCE_REPLAY_REPORT'] ?? `${recording}.rust-replay.json`,
));
const preflightOutput = resolve(String(
  process.env['XLN_RSCORE_EVIDENCE_PREFLIGHT_REPORT'] ?? `${recording}.rust-preflight.json`,
));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  XLN_RSCORE_AUTHORITY: '1',
  XLN_RSCORE_AUTHORITY_CUTOVER: '1',
  XLN_RSCORE_AUTHORITY_REPLAY: '1',
  XLN_RSCORE_AUTHORITY_IMPORT: '1',
  XLN_RSCORE_AUTHORITY_RECORD: '1',
  XLN_RSCORE_AUTHORITY_WORKERS: '1',
  XLN_RSCORE_BINARY: authorityEvidenceBinary(),
};
delete env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'];
for (const key of Object.keys(env)) {
  if (key.startsWith('XLN_RSCORE_SHADOW')) delete env[key];
}

await writeAuthorityReplayPreflight({
  recordingPath: recording,
  outputPath: preflightOutput,
  ...(process.env['XLN_RSCORE_EVIDENCE_SEED_FILE']
    ? { seedFile: process.env['XLN_RSCORE_EVIDENCE_SEED_FILE'] }
    : {}),
});
console.log(`HLT_AUTHORITY_RUST_PREFLIGHT_REPORT path=${preflightOutput}`);

runAuthorityEvidenceGate({
  label: 'HLT_AUTHORITY_RUST_REPLAY_GATE',
  script: 'core/scripts/operations/hlt/replay/replay-hub-recording.ts',
  args: [
    '--recording', recording,
    '--output', output,
    '--mode', 'max',
    '--require-complete-authority-evidence',
    '--require-rust-account-authority',
  ],
  env,
});
console.log(`HLT_AUTHORITY_RUST_REPLAY_REPORT path=${output}`);
